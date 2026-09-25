import { AgentNativeAction, ActionResult, ActionExecutionContext, ActionDescriptor } from './types';
import { robotActions } from './actions/robot';
import { projectActions } from './actions/project';
import { environmentActions } from './actions/environment';
import { codeActions } from './actions/code';
import { simulationActions } from './actions/simulation';
import { rosActions } from './actions/ros';
import { testingActions } from './actions/testing';
import { workspaceActions } from './actions/workspace';
import { bridgeActions } from './actions/bridge';
import { cadActions } from './actions/cad';
import { simulationDataSyncSetupActions } from './actions/simulation-data-sync-setup';
import { evaluateActionPolicy, createPolicyProposal } from './policy-engine';

class ActionRegistry {
  private actions: Map<string, AgentNativeAction> = new Map();

  constructor() {
    this.registerAll([
      ...projectActions,
      ...robotActions,
      ...environmentActions,
      ...codeActions,
      ...simulationActions,
      ...rosActions,
      ...testingActions,
      ...workspaceActions,
      ...bridgeActions,
      ...cadActions,
      ...simulationDataSyncSetupActions,
    ]);
  }

  public register(action: AgentNativeAction): void {
    this.actions.set(action.id, action);
  }

  public registerAll(actions: AgentNativeAction[]): void {
    for (const a of actions) {
      this.register(a);
    }
  }

  public get(actionId: string): AgentNativeAction | undefined {
    return this.actions.get(actionId);
  }

  /** Used to resolve a stored proposal (which only persists namespace+name,
   * not the full action.id — see policy-engine.ts) back to its action. */
  public findByNamespaceAndName(namespace: string, name: string): AgentNativeAction | undefined {
    return this.list().find(a => a.namespace === namespace && a.name === name);
  }

  public list(): AgentNativeAction[] {
    return Array.from(this.actions.values());
  }

  public listDescriptors(): ActionDescriptor[] {
    return this.list().map(action => ({
      id: action.id,
      namespace: action.namespace,
      name: action.name,
      description: action.description,
      defaultPolicy: action.defaultPolicy,
      parametersJsonSchema: (action.schema as any)._def ? this.zodToJsonSchema(action.schema) : {},
    }));
  }

  public async execute(actionId: string, input: any, context: ActionExecutionContext): Promise<ActionResult> {
    const startTime = Date.now();

    // /api/mcp only ever calls this after verifying a WorkOS bearer token
    // (src/lib/auth/mcp-auth.ts) — a request reaching here from 'mcp' with
    // no userId means that auth gate was bypassed or misconfigured. Fail
    // loudly rather than letting a DB-touching action silently no-op or
    // write under `undefined`.
    if (context.source === 'mcp' && !context.userId) {
      return {
        success: false,
        error: 'Internal error: MCP action execution requires an authenticated userId.',
        policyStatus: 'denied',
        executionTimeMs: Date.now() - startTime,
      };
    }

    const action = this.get(actionId);
    if (!action) {
      return {
        success: false,
        error: `Action "${actionId}" not found in UpFreq registry.`,
        policyStatus: 'denied',
        executionTimeMs: Date.now() - startTime,
      };
    }

    // 1. Validate schema
    const parseResult = action.schema.safeParse(input);
    if (!parseResult.success) {
      const issues = (parseResult.error as any).issues || (parseResult.error as any).errors || [];
      return {
        success: false,
        error: `Invalid action arguments: ${issues.map((e: any) => `${e.path?.join('.')}: ${e.message}`).join(', ')}`,
        policyStatus: 'denied',
        executionTimeMs: Date.now() - startTime,
      };
    }

    // 2. Policy Engine evaluation
    const policyDecision = evaluateActionPolicy(action, parseResult.data, context);
    if (policyDecision.level === 'DENIED') {
      return {
        success: false,
        error: policyDecision.reason || 'Action denied by UpFreq security policy.',
        policyStatus: 'denied',
        executionTimeMs: Date.now() - startTime,
      };
    }

    // NOTE: only check policyDecision.level here, never re-check the raw
    // context.autoApprove flag — evaluateActionPolicy() already applied the
    // one sanctioned autoApprove bypass (source === 'ui'). Re-checking the
    // raw flag here let ANY caller (api/mcp/cli) skip the review queue for
    // REVIEW-gated actions just by setting autoApprove: true, regardless of
    // source — a real authorization bypass, since evaluateActionPolicy's
    // source-gating became meaningless once this branch trusted the input
    // directly instead of the computed decision.
    if (policyDecision.level === 'REVIEW') {
      // Create a Proposal in the review queue
      const proposal = await createPolicyProposal(action, parseResult.data, context);
      return {
        success: true,
        data: {
          requiresApproval: true,
          proposalId: proposal.id,
          diff: proposal.diffPreview,
          rationale: proposal.rationale,
          message: `Action requires engineering review. Proposal ${proposal.id} queued for approval.`,
        },
        policyStatus: 'proposal_created',
        proposalId: proposal.id,
        executionTimeMs: Date.now() - startTime,
      };
    }

    // 3. Direct execution
    try {
      const data = await action.execute(parseResult.data, context);
      return {
        success: true,
        data,
        policyStatus: 'executed',
        executionTimeMs: Date.now() - startTime,
      };
    } catch (err: any) {
      return {
        success: false,
        error: err.message || 'Action execution failed.',
        policyStatus: 'error',
        executionTimeMs: Date.now() - startTime,
      };
    }
  }

  private zodToJsonSchema(schema: any): Record<string, any> {
    // Basic conversion for tool schemas
    return {
      type: 'object',
      properties: schema.shape ? Object.keys(schema.shape).reduce((acc: any, key) => {
        acc[key] = { type: 'string' };
        return acc;
      }, {}) : {},
    };
  }
}

export const registry = new ActionRegistry();
