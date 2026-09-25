import { z } from 'zod';

export type PolicyLevel = 'ALLOWED' | 'REVIEW' | 'DENIED';

export interface ActionExecutionContext {
  userId?: string;
  projectId?: string;
  source: 'ui' | 'agent_chat' | 'mcp' | 'api' | 'cli';
  autoApprove?: boolean;
}

export interface ActionResult<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  policyStatus: 'executed' | 'proposal_created' | 'denied' | 'error';
  proposalId?: string;
  executionTimeMs: number;
}

export interface AgentNativeAction<T = any, TOutput = any> {
  id: string; // e.g. 'upfreq.robot.validate_urdf'
  namespace: 'upfreq.robot' | 'upfreq.project' | 'upfreq.code' | 'upfreq.simulation' | 'upfreq.ros' | 'upfreq.testing' | 'upfreq.workspace' | 'upfreq.bridge' | 'upfreq.cad' | 'upfreq.simulation_data_sync_setup';
  name: string;
  description: string;
  schema: z.ZodType<T>;
  defaultPolicy: PolicyLevel;
  execute: (input: T, context: ActionExecutionContext) => Promise<TOutput>;
  generateProposalDiff?: (input: T) => Promise<{ diff: string; rationale: string; targetFile?: string }>;
}

export interface ActionDescriptor {
  id: string;
  namespace: string;
  name: string;
  description: string;
  defaultPolicy: PolicyLevel;
  parametersJsonSchema: Record<string, any>;
}
