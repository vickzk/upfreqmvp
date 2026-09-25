import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { registry } from './registry';
import { handleMcpRequest } from './mcp-gateway';

const TEST_USER_ID = 'usr_test_registry';

// run_test_case's SSRF guard (assertPublicHttpUrl, added in the production-
// readiness pass) does a real DNS lookup on the server URL before calling
// fetch. The sandboxed test environment has no network access to resolve
// 'my-tunnel.example.com', so without this mock the guard throws before
// fetchMock is ever invoked. Resolve it to a public IP so the guard passes
// and the test still exercises the real fetch call sequence below.
vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async () => [{ address: '203.0.113.10', family: 4 }]),
}));

// mcp-gateway.ts's tools/call now meters every call via
// checkAndIncrementMcpUsage (real Postgres UPDATE ... RETURNING — verified
// separately for correctness/concurrency during development, not re-run
// live here). Mocked to a controllable in-memory counter so this suite
// stays hermetic and can deliberately test both the allowed and
// over-the-limit paths.
let mockMcpCallCount = 0;
let mockMcpLimit: number | null = 100;
vi.mock('@/lib/billing/usage', () => ({
  checkAndIncrementMcpUsage: vi.fn(async () => {
    mockMcpCallCount++;
    return {
      allowed: mockMcpLimit === null || mockMcpCallCount <= mockMcpLimit,
      planId: mockMcpLimit === null ? 'pro' : 'free',
      callsThisMonth: mockMcpCallCount,
      limit: mockMcpLimit,
    };
  }),
  // Not exercised by these registry-level tests (webapp metering lives in
  // src/app/api/actions/route.ts, a route handler, not the registry) — kept
  // here just so importing this mocked module never returns undefined.
  checkAndIncrementWebappUsage: vi.fn(async () => ({ allowed: true, planId: 'free', callsThisMonth: 0, limit: null })),
}));

// upfreq.project.create_project/list_projects require a real userId and no
// longer silently fabricate data on DB failure (that was a cross-tenant bug
// — see src/lib/agent-native/actions/project.ts). Mocking the DB layer here
// keeps these tests hermetic (no live Postgres needed) while still verifying
// userId actually flows from ActionExecutionContext through to the DB call.
vi.mock('@/lib/db/projects', () => ({
  createProject: vi.fn(async (userId: string, input: { name: string; description?: string }) => ({
    id: 'proj_test', userId, name: input.name, description: input.description || '', repos: [], isAudited: false,
  })),
  listProjects: vi.fn(async (userId: string) => ([
    { id: 'proj_test', userId, name: 'Autonomous Warehouse AMR', description: '', repos: [], isAudited: false },
  ])),
}));

vi.mock('@/lib/db/custom-test-cases', () => {
  const store = new Map<string, any>();
  return {
    saveCustomTestCase: vi.fn(async (userId: string, testCase: any) => { store.set(testCase.id, testCase); }),
    getCustomTestCase: vi.fn(async (userId: string, id: string) => store.get(id) || null),
    listCustomTestCases: vi.fn(async () => Array.from(store.values())),
  };
});

vi.mock('@/lib/db/test-runs', () => ({
  saveTestRun: vi.fn(async (userId: string, input: any) => ({ id: 'run_test', userId, ...input })),
  listTestRuns: vi.fn(async (userId: string) => ([
    { id: 'run_test', userId, projectId: 'proj_test', testCaseId: 'test_kinematics_reachability', testCaseName: 'Kinematics', category: 'kinematics', status: 'passed', metrics: {}, assertions: [], logs: [], durationMs: 100, createdAt: new Date().toISOString() },
  ])),
}));

// upfreq.robot.save_robot/list_robots — same real-DB-backed, mocked-for-tests
// pattern, verified for real against live Postgres via
// scripts/_verify_mcp_loop.ts during implementation (project → save_robot →
// list_robots → workspace register/get_path/list all round-tripped
// correctly against the actual dev database).
vi.mock('@/lib/db/mcp-robots', () => {
  const robot = {
    id: 'mrb_test', userId: TEST_USER_ID, projectId: 'proj_test', name: 'verify_bot', description: '',
    driveType: 'differential', chassis: { massKg: 12 }, sensors: ['lidar_2d'],
    urdfXacroXml: '<?xml version="1.0"?>\n<robot name="verify_bot">\n  <link name="base_link"/>\n</robot>',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  return {
    saveMcpRobot: vi.fn(async (userId: string, input: any) => ({
      ...robot, userId, projectId: input.projectId || null, name: input.name,
      description: input.description || '', driveType: input.driveType || null,
      chassis: input.chassis || {}, sensors: input.sensors || [], urdfXacroXml: input.urdfXacroXml || null,
    })),
    listMcpRobots: vi.fn(async (userId: string, projectId?: string) => ([{ ...robot, userId, projectId: projectId || robot.projectId }])),
    getMcpRobot: vi.fn(async (userId: string, id: string) => (id === robot.id ? { ...robot, userId } : null)),
    updateMcpRobot: vi.fn(async (userId: string, id: string, urdfXacroXml: string) =>
      id === robot.id ? { ...robot, userId, urdfXacroXml, updatedAt: new Date().toISOString() } : null
    ),
  };
});

// upfreq.cad.compile_part's real dependencies (WASM OpenSCAD compilation,
// Vercel Blob upload) are verified for real separately — running the actual
// ~13MB WASM module and hitting real cloud storage on every fast-suite run
// would be slow and network-dependent, the same reason run_test_case mocks
// fetch instead of requiring a live Isaac Sim server. mesh-mass-properties
// itself (the physics-critical part) IS tested for real against the
// analytical box formula in mesh-mass-properties.test.ts — this mock only
// stands in for the compiler/upload plumbing around it.
vi.mock('@/lib/cad/mesh-compiler', () => ({
  compileScadToStl: vi.fn(async (scad: string) => {
    if (!scad.includes('cube')) throw new Error('test STL mock only supports cube()');
    return 'solid box\nfacet normal 0 0 -1\nouter loop\nvertex -1 -1 -1\nvertex 1 -1 -1\nvertex 1 1 -1\nendloop\nendfacet\nfacet normal 0 0 -1\nouter loop\nvertex -1 -1 -1\nvertex 1 1 -1\nvertex -1 1 -1\nendloop\nendfacet\nfacet normal 0 0 1\nouter loop\nvertex -1 -1 1\nvertex 1 1 1\nvertex 1 -1 1\nendloop\nendfacet\nfacet normal 0 0 1\nouter loop\nvertex -1 -1 1\nvertex -1 1 1\nvertex 1 1 1\nendloop\nendfacet\nfacet normal 0 -1 0\nouter loop\nvertex -1 -1 -1\nvertex 1 -1 1\nvertex 1 -1 -1\nendloop\nendfacet\nfacet normal 0 -1 0\nouter loop\nvertex -1 -1 -1\nvertex -1 -1 1\nvertex 1 -1 1\nendloop\nendfacet\nfacet normal 0 1 0\nouter loop\nvertex -1 1 -1\nvertex 1 1 -1\nvertex 1 1 1\nendloop\nendfacet\nfacet normal 0 1 0\nouter loop\nvertex -1 1 -1\nvertex 1 1 1\nvertex -1 1 1\nendloop\nendfacet\nfacet normal -1 0 0\nouter loop\nvertex -1 -1 -1\nvertex -1 1 -1\nvertex -1 1 1\nendloop\nendfacet\nfacet normal -1 0 0\nouter loop\nvertex -1 -1 -1\nvertex -1 1 1\nvertex -1 -1 1\nendloop\nendfacet\nfacet normal 1 0 0\nouter loop\nvertex 1 -1 -1\nvertex 1 1 1\nvertex 1 1 -1\nendloop\nendfacet\nfacet normal 1 0 0\nouter loop\nvertex 1 -1 -1\nvertex 1 -1 1\nvertex 1 1 1\nendloop\nendfacet\nendsolid box';
  }),
}));

vi.mock('@/lib/cad/blob-storage', () => ({
  uploadStlToBlob: vi.fn(async (userId: string, partId: string) => `https://test-blob.example.com/cad-parts/${userId}/${partId}.stl`),
  deleteStlFromBlob: vi.fn(async () => {}),
}));

vi.mock('@/lib/db/cad-parts', () => {
  const store = new Map<string, any>();
  return {
    saveCadPart: vi.fn(async (userId: string, input: any) => {
      const part = { id: input.id || 'cad_test', userId, projectId: input.projectId || null, name: input.name, description: input.description || '', nodeTree: input.nodeTree, scadSource: input.scadSource, stlUrl: input.stlUrl || null, massProperties: input.massProperties || null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      store.set(part.id, part);
      return part;
    }),
    listCadParts: vi.fn(async (userId: string) => Array.from(store.values())),
    getCadPart: vi.fn(async (userId: string, id: string) => store.get(id) || null),
  };
});

vi.mock('@/lib/db/bridge-endpoints', () => {
  const store = new Map<string, any>();
  return {
    getBridgeEndpoint: vi.fn(async (userId: string, projectId: string, machineId: string, endpointType: string) =>
      store.get(`${projectId}:${machineId}:${endpointType}`) || null
    ),
    registerBridgeEndpoint: vi.fn(async (userId: string, projectId: string, machineId: string, endpointType: string, url: string) => {
      const record = { id: 'brg_test', projectId, machineId, endpointType, url, apiKey: null, lastSeenAt: new Date().toISOString(), createdAt: new Date().toISOString() };
      store.set(`${projectId}:${machineId}:${endpointType}`, record);
      return record;
    }),
    listBridgeEndpoints: vi.fn(async () => Array.from(store.values())),
  };
});

vi.mock('@/lib/db/workspace-registrations', () => {
  const store = new Map<string, { id: string; projectId: string; machineId: string; localPath: string; lastSeenAt: string; createdAt: string }>();
  return {
    getWorkspacePath: vi.fn(async (userId: string, projectId: string, machineId: string) => store.get(`${projectId}:${machineId}`) || null),
    registerWorkspacePath: vi.fn(async (userId: string, projectId: string, machineId: string, localPath: string) => {
      const record = { id: 'wsr_test', projectId, machineId, localPath, lastSeenAt: new Date().toISOString(), createdAt: new Date().toISOString() };
      store.set(`${projectId}:${machineId}`, record);
      return record;
    }),
    listWorkspaces: vi.fn(async () => Array.from(store.values())),
  };
});

describe('Agent-Native Action Registry & MCP Gateway', () => {
  it('registers all canonical namespaces and descriptors', () => {
    const descriptors = registry.listDescriptors();
    expect(descriptors.length).toBeGreaterThanOrEqual(20);

    const namespaces = new Set(descriptors.map(d => d.namespace));
    expect(namespaces.has('upfreq.robot')).toBe(true);
    expect(namespaces.has('upfreq.code')).toBe(true);
    expect(namespaces.has('upfreq.simulation')).toBe(true);
    expect(namespaces.has('upfreq.ros')).toBe(true);
    expect(namespaces.has('upfreq.testing')).toBe(true);
    expect(namespaces.has('upfreq.workspace')).toBe(true);
    expect(namespaces.has('upfreq.bridge')).toBe(true);
    expect(namespaces.has('upfreq.cad')).toBe(true);
    expect(namespaces.has('upfreq.simulation_data_sync_setup')).toBe(true);
  });

  it('enforces Policy Engine: ALLOWED actions execute immediately', async () => {
    const result = await registry.execute(
      'upfreq.robot.calculate_inertias',
      {
        geometryType: 'box',
        massKg: 10,
        dimensions: { x: 0.5, y: 0.5, z: 0.5 },
      },
      { source: 'api' }
    );

    expect(result.success).toBe(true);
    expect(result.policyStatus).toBe('executed');
    expect(result.data.positiveDefinite).toBe(true);
  });

  it('executes project creation and listing via MCP action', async () => {
    const createResult = await registry.execute(
      'upfreq.project.create_project',
      {
        name: 'Autonomous Warehouse AMR',
        description: 'ROS 2 Nav2 and Cartographer SLAM fleet project',
      },
      { source: 'api', userId: TEST_USER_ID }
    );

    expect(createResult.success).toBe(true);
    expect(createResult.data.project.name).toBe('Autonomous Warehouse AMR');

    const listResult = await registry.execute(
      'upfreq.project.list_projects',
      {},
      { source: 'api', userId: TEST_USER_ID }
    );

    expect(listResult.success).toBe(true);
    expect(listResult.data.count).toBeGreaterThanOrEqual(1);
  });

  it('queries simulation environments and stages them in a real (mocked) Isaac Sim server', async () => {
    const listEnvs = await registry.execute(
      'upfreq.environment.list_environments',
      {},
      { source: 'api' }
    );

    expect(listEnvs.success).toBe(true);
    expect(listEnvs.data.count).toBeGreaterThanOrEqual(3);

    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal('fetch', fetchMock);

    const selectEnv = await registry.execute(
      'upfreq.environment.select_environment',
      {
        environmentKey: 'warehouse',
        robotName: 'heavy_payload_transporter',
        serverUrl: 'https://my-tunnel.example.com',
      },
      { source: 'api' }
    );

    expect(selectEnv.success).toBe(true);
    expect(selectEnv.data.environmentKey).toBe('warehouse');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://my-tunnel.example.com/api/v1/scenario/select-environment',
      expect.objectContaining({ method: 'POST' })
    );

    vi.unstubAllGlobals();
  });

  it('setup_isaac_sim resolves the real NVIDIA WebRTC viewer URL and auto-registers the endpoint', async () => {
    const result = await registry.execute(
      'upfreq.simulation.setup_isaac_sim',
      { serverUrl: 'https://my-tunnel.example.com', projectId: 'proj_test', machineId: 'machine_test' },
      { source: 'mcp', userId: TEST_USER_ID }
    );

    expect(result.success).toBe(true);
    expect(result.data.viewerUrl).toBe('http://my-tunnel.example.com:8211/streaming/webrtc-client?server=my-tunnel.example.com');

    // Convenience side effect: registered so a later call can omit serverUrl.
    const { getBridgeEndpoint } = await import('@/lib/db/bridge-endpoints');
    const registered = await getBridgeEndpoint(TEST_USER_ID, 'proj_test', 'machine_test', 'isaac_sim');
    expect(registered?.url).toBe('https://my-tunnel.example.com');

    // Second call, no serverUrl — resolves from the registration above.
    const secondCall = await registry.execute(
      'upfreq.simulation.setup_isaac_sim',
      { projectId: 'proj_test', machineId: 'machine_test' },
      { source: 'mcp', userId: TEST_USER_ID }
    );
    expect(secondCall.success).toBe(true);
    expect(secondCall.data.viewerUrl).toContain('my-tunnel.example.com:8211');
  });

  describe('run_test_case against a real (mocked) Isaac Sim server', () => {
    const fetchMock = vi.fn();

    beforeEach(() => {
      vi.stubGlobal('fetch', fetchMock);
      fetchMock.mockReset();
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('health-checks, runs the test, evaluates assertions, and persists the run', async () => {
      fetchMock
        .mockResolvedValueOnce({ ok: true, json: async () => ({ isaac_sim: { fps: 60 } }) }) // /health
        .mockResolvedValueOnce({ ok: true, json: async () => ({ metrics: { minObstacleClearanceM: 0.42 }, logs: ['[Isaac Sim] done'] }) }); // /api/v1/run-test

      const result = await registry.execute(
        'upfreq.testing.run_test_case',
        {
          testCaseId: 'test_kinematics_reachability',
          robotName: 'heavy_payload_transporter',
          environment: 'narrow_corridor',
          serverUrl: 'https://my-tunnel.example.com',
        },
        { source: 'mcp', userId: TEST_USER_ID }
      );

      expect(result.success).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[0][0]).toBe('https://my-tunnel.example.com/health');
      expect(fetchMock.mock.calls[1][0]).toBe('https://my-tunnel.example.com/api/v1/run-test');
      expect(result.data.status).toBe('failed'); // singularity_index (0, default) < 0.85 target
      expect(result.data.metrics.minObstacleClearanceM).toBe(0.42);
    });

    it('records a status: error run when the Isaac Sim server is unreachable', async () => {
      fetchMock.mockRejectedValueOnce(new Error('fetch failed'));

      const result = await registry.execute(
        'upfreq.testing.run_test_case',
        {
          testCaseId: 'test_kinematics_reachability',
          robotName: 'heavy_payload_transporter',
          environment: 'grid',
          serverUrl: 'https://unreachable.example.com',
        },
        { source: 'mcp', userId: TEST_USER_ID }
      );

      expect(result.success).toBe(true); // the action itself doesn't throw — it reports the failure
      expect(result.data.status).toBe('error');
    });

    it('an unknown testCaseId errors clearly instead of silently substituting a different test', async () => {
      // Regression test for a real bug found in a fresh audit pass: this
      // used to fall back to STANDARD_TEST_PRESETS[0] and report success/
      // failure for THAT test while claiming to have run the requested
      // (nonexistent) one — actively dangerous for a safety-testing tool.
      const result = await registry.execute(
        'upfreq.testing.run_test_case',
        {
          testCaseId: 'this_test_case_does_not_exist',
          robotName: 'heavy_payload_transporter',
          environment: 'grid',
          serverUrl: 'https://my-tunnel.example.com',
        },
        { source: 'mcp', userId: TEST_USER_ID }
      );

      expect(result.data.status).toBe('error');
      expect(result.data.error).toMatch(/no test case found/i);
      expect(fetchMock).not.toHaveBeenCalled(); // never even tried to reach a server for a test that doesn't exist
    });

    it('create_test_case persists a real, runnable custom test case', async () => {
      const created = await registry.execute(
        'upfreq.testing.create_test_case',
        {
          name: 'Strict Pallet Clearance',
          description: 'Custom tighter clearance requirement for narrow aisles',
          assertionType: 'min_clearance',
          thresholdValue: 0.75,
        },
        { source: 'mcp', userId: TEST_USER_ID }
      );
      expect(created.success).toBe(true);
      const customId = created.data.testCase.id;

      const listed = await registry.execute('upfreq.testing.list_test_presets', {}, { source: 'mcp', userId: TEST_USER_ID });
      expect(listed.data.presets.some((p: any) => p.id === customId)).toBe(true);

      fetchMock
        .mockResolvedValueOnce({ ok: true, json: async () => ({}) }) // /health
        .mockResolvedValueOnce({ ok: true, json: async () => ({ metrics: { min_clearance_m: 0.9 }, logs: [] }) }); // /api/v1/run-test

      const run = await registry.execute(
        'upfreq.testing.run_test_case',
        { testCaseId: customId, serverUrl: 'https://my-tunnel.example.com' },
        { source: 'mcp', userId: TEST_USER_ID }
      );
      expect(run.data.status).toBe('passed'); // 0.9 >= 0.75 threshold
      expect(run.data.testCaseId).toBe(customId);
    });
  });

  describe('CAD pipeline: generate -> compile -> save -> attach to robot', () => {
    const boxNode = {
      kind: 'primitive' as const,
      primitive: { type: 'box' as const, size: [2, 2, 2] as [number, number, number] },
    };

    it('generate_part produces real, deterministic OpenSCAD source with no compilation', async () => {
      const result = await registry.execute('upfreq.cad.generate_part', { node: boxNode }, { source: 'mcp', userId: TEST_USER_ID });
      expect(result.success).toBe(true);
      expect(result.data.scadSource).toContain('cube([2, 2, 2], center=true);');
    });

    it('compile_part compiles to real STL geometry and computes real mass properties', async () => {
      const result = await registry.execute(
        'upfreq.cad.compile_part',
        { node: boxNode, massKg: 8 },
        { source: 'mcp', userId: TEST_USER_ID }
      );
      expect(result.success).toBe(true);
      expect(result.data.stlUrl).toMatch(/^https:\/\/test-blob\.example\.com\//);
      // The mocked STL is a 2x2x2 cube centered at origin — verifies the
      // real mesh-mass-properties integration ran against it, not a stub.
      expect(result.data.massProperties.volumeM3).toBeCloseTo(8, 3);
      expect(result.data.massProperties.centerOfMass.x).toBeCloseTo(0, 3);
      expect(result.data.massProperties.massKg).toBe(8);

      const saveResult = await registry.execute(
        'upfreq.cad.save_part',
        {
          projectId: 'proj_test',
          name: 'sensor_mount',
          node: boxNode,
          scadSource: result.data.scadSource,
          stlUrl: result.data.stlUrl,
          massProperties: result.data.massProperties,
        },
        { source: 'mcp', userId: TEST_USER_ID }
      );
      expect(saveResult.success).toBe(true);
      expect(saveResult.data.part.name).toBe('sensor_mount');

      const listResult = await registry.execute('upfreq.cad.list_parts', {}, { source: 'mcp', userId: TEST_USER_ID });
      expect(listResult.data.count).toBeGreaterThanOrEqual(1);

      // attach_to_robot is REVIEW-policy (real proposal-queue creation is a
      // live-DB path not mocked in this suite, same reason it isn't tested
      // elsewhere here) — execute directly via the one sanctioned bypass
      // ('ui' + autoApprove, same as after a human approves a real
      // proposal) to verify the actual URDF-mutation logic.
      const attached = await registry.execute(
        'upfreq.cad.attach_to_robot',
        { robotId: 'mrb_test', cadPartId: saveResult.data.part.id, linkName: 'sensor_mount_link' },
        { source: 'ui', userId: TEST_USER_ID, autoApprove: true }
      );
      expect(attached.success).toBe(true);
      expect(attached.data.robot.urdfXacroXml).toContain('link name="sensor_mount_link"');
      expect(attached.data.robot.urdfXacroXml).toContain(saveResult.data.part.stlUrl);
      expect(attached.data.robot.urdfXacroXml).toContain('</robot>'); // still well-formed
    });
  });

  describe('simulation_data_sync_setup: laptop -> GPU machine MinIO sync', () => {
    const ctx = { source: 'mcp' as const, userId: TEST_USER_ID };
    const NS = 'upfreq.simulation_data_sync_setup';
    const runOf = (result: any) => result.data.steps.map((s: any) => s.run).join('\n');

    it('setup_sim_sync returns the full runbook for the agent to execute, in order', async () => {
      const result = await registry.execute(`${NS}.setup_sim_sync`, { sshTarget: 'ubuntu@10.0.0.42' }, ctx);
      expect(result.success).toBe(true);
      expect(result.data.agentInstructions).toMatch(/Run every step yourself/);
      const run = runOf(result);
      const order = ['docker compose version', "echo ssh_ok", 'MINIO_BUCKET_NAME sim-data-files', 'docker pull -q ghcr.io/upfreq-robotics/minio_sync:latest',
        'up -d --force-recreate minio\n', 'cat > ~/.upfreq/runtime.env', 'grep -c "^>"', '--profile sync up -d --force-recreate minio_gpu_sync', 'sync_ok'];
      const positions = order.map(needle => run.indexOf(needle));
      expect(positions.every(p => p >= 0)).toBe(true);
      expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    });

    it('setup_sim_sync requires the GPU machine\'s ssh target', async () => {
      const result = await registry.execute(`${NS}.setup_sim_sync`, {}, ctx);
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/sshTarget/);
    });

    it('keeps credentials on the user\'s machines: generated locally, compared by checksum, never echoed', async () => {
      const result = await registry.execute(`${NS}.setup_sim_sync`, { sshTarget: 'ubuntu@10.0.0.42', sshPort: 2222, sshKeyPath: '~/.ssh/id_ed25519' }, ctx);
      const run = runOf(result);
      expect(run).toContain('SSH="ssh -o BatchMode=yes -o ConnectTimeout=10 -p 2222 -i $HOME/.ssh/id_ed25519 ubuntu@10.0.0.42"');
      expect(run).toContain('grep -v "^GPU_MINIO_ENDPOINT=" "$ENV" | $SSH');
      expect(run).toContain('STOP: the GPU machine already has DIFFERENT MinIO credentials');
      expect(run).not.toMatch(/cat "?\$(HOME\/\.upfreq\/runtime\.env|ENV)"?\s*$/m);
    });

    it('start_sync refuses to delete GPU-only objects unless the user allowed it', async () => {
      const guarded = runOf(await registry.execute(`${NS}.start_sync`, {}, ctx));
      expect(guarded).toContain('STOP: the sync mirrors with --remove');
      const allowed = runOf(await registry.execute(`${NS}.start_sync`, { allowGpuDeletes: true }, ctx));
      expect(allowed).not.toContain('STOP:');
      expect(allowed).toContain('user approved deleting them');
    });

    it('init_config uses gpuMinioHost when given, else resolves the ssh host', async () => {
      const explicit = runOf(await registry.execute(`${NS}.init_config`, { sshTarget: 'gpubox', gpuMinioHost: '100.64.0.7', bucketName: 'robot-runs' }, ctx));
      expect(explicit).toContain('GPU_HOST=100.64.0.7');
      expect(explicit).toContain('set_kv MINIO_BUCKET_NAME robot-runs');
      expect(runOf(await registry.execute(`${NS}.init_config`, { sshTarget: 'gpubox' }, ctx))).toContain("ssh -G gpubox");
    });

    it('rejects inputs that could inject into the generated shell commands', async () => {
      const bad = [
        ['check_gpu_ssh', { sshTarget: 'ubuntu@host; rm -rf ~' }],
        ['setup_gpu_minio', { sshTarget: 'ubuntu@host', sshKeyPath: '~/.ssh/key $(whoami)' }],
        ['init_config', { sshTarget: 'ubuntu@host', gpuMinioHost: 'host`id`' }],
        ['init_config', { sshTarget: 'ubuntu@host', bucketName: 'sim_data_files' }],
      ] as const;
      for (const [name, args] of bad) {
        const result = await registry.execute(`${NS}.${name}`, args, ctx);
        expect(result.success).toBe(false);
        expect(result.policyStatus).toBe('denied');
      }
    });
  });

  it('saves a robot via MCP and lists it back', async () => {
    const saveResult = await registry.execute(
      'upfreq.robot.save_robot',
      {
        projectId: 'proj_test',
        name: 'verify_bot',
        driveType: 'differential',
        chassisDimensions: { length: 0.5, width: 0.4, height: 0.2, massKg: 12 },
        sensors: ['lidar_2d'],
        urdfXacroXml: '<robot name="verify_bot"/>',
      },
      { source: 'mcp', userId: TEST_USER_ID }
    );

    expect(saveResult.success).toBe(true);
    expect(saveResult.data.robot.name).toBe('verify_bot');
    // chassisDimensions were provided in full, so the inertia tensor should
    // have been computed and stored alongside the raw dimensions.
    expect(saveResult.data.robot.chassis.inertia.ixx).toBeGreaterThan(0);

    const listResult = await registry.execute(
      'upfreq.robot.list_robots',
      { projectId: 'proj_test' },
      { source: 'mcp', userId: TEST_USER_ID }
    );

    expect(listResult.success).toBe(true);
    expect(listResult.data.count).toBe(1);
    expect(listResult.data.robots[0].name).toBe('verify_bot');
  });

  it('registers and looks up a per-machine workspace path via MCP', async () => {
    const notFoundYet = await registry.execute(
      'upfreq.workspace.get_path',
      { projectId: 'proj_test', machineId: 'machine_a' },
      { source: 'mcp', userId: TEST_USER_ID }
    );
    expect(notFoundYet.data.found).toBe(false);

    const registerResult = await registry.execute(
      'upfreq.workspace.register',
      { projectId: 'proj_test', machineId: 'machine_a', localPath: '/Users/alex/code/verify-bot' },
      { source: 'mcp', userId: TEST_USER_ID }
    );
    expect(registerResult.success).toBe(true);

    const foundNow = await registry.execute(
      'upfreq.workspace.get_path',
      { projectId: 'proj_test', machineId: 'machine_a' },
      { source: 'mcp', userId: TEST_USER_ID }
    );
    expect(foundNow.data.found).toBe(true);
    expect(foundNow.data.localPath).toBe('/Users/alex/code/verify-bot');

    const listResult = await registry.execute(
      'upfreq.workspace.list',
      {},
      { source: 'mcp', userId: TEST_USER_ID }
    );
    expect(listResult.data.count).toBe(1);
  });

  it('lists past test runs via MCP', async () => {
    const result = await registry.execute(
      'upfreq.testing.list_runs',
      { projectId: 'proj_test' },
      { source: 'mcp', userId: TEST_USER_ID }
    );

    expect(result.success).toBe(true);
    expect(result.data.count).toBeGreaterThanOrEqual(1);
  });

  it('serves standard MCP tools/list and tools/call over JSON-RPC', async () => {
    const initRes = await handleMcpRequest({ method: 'initialize', id: 1 }, TEST_USER_ID);
    expect(initRes.result.serverInfo.name).toBe('upfreq-robotics-mcp');

    const toolsRes = await handleMcpRequest({ method: 'tools/list', id: 2 }, TEST_USER_ID);
    expect(toolsRes.result.tools.length).toBeGreaterThanOrEqual(15);

    // Real per-action JSON Schema via Mastra's schema-conversion utilities
    // (src/lib/agent-native/mastra-mcp-server.ts) — not the old stub that
    // mapped every field to `{ type: 'string' }` regardless of its real type.
    const inertiaTool = toolsRes.result.tools.find((t: any) => t.name === 'upfreq.robot.calculate_inertias');
    expect(inertiaTool.inputSchema.type).toBe('object');
    expect(inertiaTool.inputSchema.properties.massKg.type).toBe('number');
    expect(inertiaTool.inputSchema.properties.geometryType.enum).toEqual(['box', 'cylinder', 'sphere']);

    const callRes = await handleMcpRequest({
      method: 'tools/call',
      id: 3,
      params: {
        name: 'upfreq.robot.calculate_inertias',
        arguments: { geometryType: 'box', massKg: 10, dimensions: { x: 0.5, y: 0.5, z: 0.5 } },
      },
    }, TEST_USER_ID);

    expect(callRes.result.content[0].text).toContain('positiveDefinite');
  });

  it('blocks tools/call once the free-tier monthly MCP quota is exceeded, but tools/list stays free', async () => {
    mockMcpCallCount = 0;
    mockMcpLimit = 3;

    for (let i = 0; i < 3; i++) {
      const res = await handleMcpRequest({
        method: 'tools/call', id: i,
        params: { name: 'upfreq.robot.calculate_inertias', arguments: { geometryType: 'box', massKg: 5, dimensions: { x: 0.2, y: 0.2, z: 0.2 } } },
      }, TEST_USER_ID);
      expect(res.error).toBeUndefined();
    }

    // The 4th call is over the limit — must be rejected with a clear,
    // actionable JSON-RPC error, not silently executed.
    const blocked = await handleMcpRequest({
      method: 'tools/call', id: 4,
      params: { name: 'upfreq.robot.calculate_inertias', arguments: { geometryType: 'box', massKg: 5, dimensions: { x: 0.2, y: 0.2, z: 0.2 } } },
    }, TEST_USER_ID);
    expect(blocked.error).toBeDefined();
    expect(blocked.error?.code).toBe(-32000);
    expect(blocked.error?.message).toMatch(/limit reached/i);
    expect(blocked.result).toBeUndefined();

    // Discovery calls (tools/list) are never metered — a user who's hit
    // their quota can still see what's available, just not execute more.
    mockMcpCallCount = 999; // simulate already-over-limit state
    const listRes = await handleMcpRequest({ method: 'tools/list', id: 5 }, TEST_USER_ID);
    expect(listRes.error).toBeUndefined();
    expect(listRes.result.tools.length).toBeGreaterThan(0);

    mockMcpCallCount = 0;
    mockMcpLimit = 100; // restore defaults for any tests that run after this one
  });
});
