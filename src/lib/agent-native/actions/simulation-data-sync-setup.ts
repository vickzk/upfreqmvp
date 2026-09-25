import { z } from 'zod';
import { AgentNativeAction } from '../types';

// Sets up the simulation data sync from upfreq-robotics/minio_sync: a MinIO
// server on the user's laptop and on their GPU machine (each creates the
// shared bucket on startup), plus the minio_gpu_sync container on the laptop,
// which runs `mc mirror --watch --overwrite --remove` from the laptop bucket
// to the GPU bucket over the S3 API.
//
// Like upfreq.workspace.*, none of this can run on UpFreq's backend — it all
// happens on the user's own machines. So every action returns shell steps for
// the calling agent (Claude Code / Codex / Cursor, running on the laptop) to
// execute itself; steps that target the GPU machine go through ssh. MinIO
// credentials are generated on (or copied between) the user's machines and
// never pass through UpFreq or get printed.
//
// The compose file and minio_init.sh below are copied verbatim from the
// minio_sync repo — keep them in sync with it.

const NS = 'upfreq.simulation_data_sync_setup' as const;

const MINIO_IMAGE = 'cgr.dev/chainguard/minio:latest';
const SYNC_IMAGE = 'ghcr.io/upfreq-robotics/minio_sync:latest';

// Both machines: ~/.upfreq/runtime.env (the only config file) and the compose
// project in ~/.upfreq/minio_sync, so its compose project name matches a
// manual checkout of the minio_sync repo and re-running replaces that setup
// instead of fighting it for ports 9000/9001.
const ENV_FILE = '$HOME/.upfreq/runtime.env';
const PROJECT_DIR = '$HOME/.upfreq/minio_sync';
const COMPOSE = `docker compose -f ${PROJECT_DIR}/docker-compose.yaml`;
const REMOTE_COMPOSE = 'docker compose -f ~/.upfreq/minio_sync/docker-compose.yaml';

const COMPOSE_YAML = `services:
  minio:
    image: cgr.dev/chainguard/minio:latest
    user: "0:0"
    volumes:
      - $HOME/upfreq/projects/sim_data_files:/data
      - ./minio_init.sh:/minio_init.sh:ro
    ports:
      - 9000:9000
      - 9001:9001
    ipc: host
    pid: host
    network_mode: host
    privileged: true
    env_file:
      - $HOME/.upfreq/runtime.env
    entrypoint: ["/bin/sh", "/minio_init.sh"]

  # Only runs on the source machine: docker compose --profile sync up -d
  minio_gpu_sync:
    image: ghcr.io/upfreq-robotics/minio_sync:latest
    container_name: minio_gpu_sync
    restart: always
    profiles: [sync]
    depends_on: [minio]
    ipc: host
    pid: host
    network_mode: host
    privileged: true
    env_file:
      - $HOME/.upfreq/runtime.env
`;

const MINIO_INIT_SH = `#!/bin/sh

set -e

: "\${MINIO_ROOT_USER:?Need to set MINIO_ROOT_USER}"
: "\${MINIO_ROOT_PASSWORD:?Need to set MINIO_ROOT_PASSWORD}"
: "\${MINIO_BUCKET_NAME:?Need to set MINIO_BUCKET_NAME}"

# Start MinIO in the background and forward stop signals to it
minio server /data &
MINIO_PID=$!
trap 'kill -TERM "$MINIO_PID"; wait "$MINIO_PID"' TERM INT

# Wait for the server, then create the shared bucket if it doesn't exist
until mc alias set local "http://127.0.0.1\${MINIO_ADDRESS:-:9000}" "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null 2>&1; do
  sleep 1
done
mc mb --ignore-existing "local/\${MINIO_BUCKET_NAME}"

wait "$MINIO_PID"
`;

const AGENT_INSTRUCTIONS = [
  'Run every step yourself, in order, with your shell tool on the user\'s LAPTOP — do not just show the commands to the user. Steps that target the GPU machine already go through ssh.',
  'After each step, check its `verify`; if it fails, use `onFailure` to fix it and re-run the step before moving on.',
  'If a step prints a line starting with "STOP:", stop and ask the user what the line asks — never work around it on your own (it guards credentials or data deletion).',
  'Never print ~/.upfreq/runtime.env or the MinIO password; the steps are written so neither ever appears in output.',
].join(' ');

interface SetupStep {
  title: string;
  run: string;
  verify?: string;
  onFailure?: string;
}

function plan(steps: SetupStep[], next?: string) {
  return { runOn: 'laptop', agentInstructions: AGENT_INSTRUCTIONS, steps, ...(next ? { next } : {}) };
}

// Everything below is interpolated into shell commands, so it's restricted to
// characters that can't break out of them.
const HOST_REGEX = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;

const sshFields = {
  sshTarget: z
    .string()
    .regex(/^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/, 'Expected user@host or an ~/.ssh/config Host alias')
    .describe('SSH destination of the GPU machine, e.g. ubuntu@100.108.159.92 or an ~/.ssh/config Host alias'),
  sshPort: z.number().int().min(1).max(65535).default(22),
  sshKeyPath: z
    .string()
    .regex(/^[A-Za-z0-9_./~-]+$/, 'Only letters, digits, and _ . / ~ - are allowed')
    .optional()
    .describe('Private key to use, e.g. ~/.ssh/id_ed25519 — omit to use the ssh agent / ~/.ssh/config'),
};

const configFields = {
  gpuMinioHost: z
    .string()
    .regex(HOST_REGEX, 'Expected a hostname or IP address')
    .optional()
    .describe('Hostname/IP the laptop uses to reach the GPU machine\'s MinIO — defaults to the SSH host (resolved through ~/.ssh/config). Set it if they differ, e.g. a Tailscale IP'),
  bucketName: z
    .string()
    .regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, 'S3 bucket names are 3-63 chars of lowercase letters, digits, dots and hyphens (no underscores)')
    .default('sim-data-files')
    .describe('Bucket created on both machines and synced between them (MINIO_BUCKET_NAME)'),
};

const syncFields = {
  allowGpuDeletes: z
    .boolean()
    .default(false)
    .describe('Only set true after the user explicitly agreed that objects existing only in the GPU bucket may be deleted by the sync (it mirrors with --remove)'),
};

type SshInput = { sshTarget: string; sshPort: number; sshKeyPath?: string };
type ConfigInput = SshInput & { gpuMinioHost?: string; bucketName: string };

function sshVar(input: SshInput): string {
  const parts = ['ssh', '-o BatchMode=yes', '-o ConnectTimeout=10'];
  if (input.sshPort !== 22) parts.push(`-p ${input.sshPort}`);
  if (input.sshKeyPath) parts.push(`-i ${input.sshKeyPath.replace(/^~(?=\/)/, '$HOME')}`);
  parts.push(input.sshTarget);
  return `SSH="${parts.join(' ')}"`;
}

// Runs a bash snippet inside the sync image (it has bash + mc) with the
// laptop's runtime.env, with aliases l (laptop MinIO) and g (GPU MinIO) and
// $B (the bucket) set. The snippet must not contain single quotes.
function withMc(body: string): string {
  const prelude =
    'mc alias set l "http://127.0.0.1${MINIO_ADDRESS:-:9000}" "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null && ' +
    'mc alias set g "$GPU_MINIO_ENDPOINT" "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null && ' +
    'B="$MINIO_BUCKET_NAME"';
  return `docker run --rm --network host --env-file "${ENV_FILE}" --entrypoint bash ${SYNC_IMAGE} -c '${prelude}\n${body}'`;
}

const PORT_FROM_ENV = `PORT=$(sed -n 's/^MINIO_ADDRESS=.*:\\([0-9]*\\)$/\\1/p' "${ENV_FILE}"); PORT=\${PORT:-9000}`;

function laptopPreflightSteps(): SetupStep[] {
  return [{
    title: 'Check Docker and Docker Compose on the laptop',
    run: 'docker --version && docker compose version && docker info --format "Docker daemon {{.ServerVersion}} OK"',
    verify: 'All three print a version.',
    onFailure: 'Install Docker Engine + the Compose plugin, or start the daemon / add the user to the docker group. On macOS, Docker Desktop needs host networking enabled (Settings → Resources → Network), since the services use network_mode: host.',
  }];
}

function gpuSshSteps(input: SshInput): SetupStep[] {
  const ssh = sshVar(input);
  return [
    {
      title: 'Check key-based SSH into the GPU machine',
      run: `${ssh}\n$SSH 'echo ssh_ok on $(hostname)'`,
      verify: 'Prints "ssh_ok on <hostname>".',
      onFailure: '"Permission denied": ask the user to authorize a key (e.g. `ssh-copy-id <target>`). "Host key verification failed": ask the user to ssh into it once interactively to accept the host key. Timeout: wrong host, or the machine is off / not on the same network or tailnet.',
    },
    {
      title: 'Check Docker, Docker Compose and the GPU on the GPU machine',
      run: `${ssh}\n$SSH 'docker --version && docker compose version && docker info --format "Docker daemon {{.ServerVersion}} OK" && (nvidia-smi -L || echo "WARNING: nvidia-smi failed — no NVIDIA GPU/driver visible")'`,
      verify: 'Docker/Compose versions print. A nvidia-smi WARNING doesn\'t block the sync, but tell the user.',
      onFailure: 'Docker missing or "permission denied" on the socket: the user needs Docker Engine + Compose plugin on the GPU machine and their SSH user in the docker group.',
    },
  ];
}

function initConfigSteps(input: ConfigInput): SetupStep[] {
  const hostLine = input.gpuMinioHost
    ? `GPU_HOST=${input.gpuMinioHost}`
    : `GPU_HOST=$(ssh -G ${input.sshTarget} | awk '/^hostname /{print $2; exit}')`;
  return [{
    title: 'Create ~/.upfreq, the MinIO data folder and ~/.upfreq/runtime.env on the laptop',
    run: [
      'set -e',
      sshVar(input),
      `ENV="${ENV_FILE}"`,
      'mkdir -p "$HOME/.upfreq/minio_sync" "$HOME/upfreq/projects/sim_data_files" && chmod 700 "$HOME/.upfreq"',
      'rand() { head -c "$1" /dev/urandom | od -An -tx1 | tr -d " \\n"; }',
      'set_kv() { { grep -v "^$1=" "$ENV" || true; echo "$1=$2"; } > "$ENV.tmp" && chmod 600 "$ENV.tmp" && mv "$ENV.tmp" "$ENV"; }',
      'touch "$ENV" && chmod 600 "$ENV"',
      '# Credentials: keep the laptop\'s, else reuse the GPU machine\'s, else generate — so both sides always share one set',
      'if grep -q "^MINIO_ROOT_PASSWORD=" "$ENV"; then',
      '  echo "Credentials: keeping the existing laptop ones"',
      'elif GPU_CREDS=$($SSH \'grep -E "^MINIO_ROOT_(USER|PASSWORD)=" ~/.upfreq/runtime.env\' 2>/dev/null) && [ -n "$GPU_CREDS" ]; then',
      '  echo "$GPU_CREDS" | while IFS="=" read -r k v; do set_kv "$k" "$v"; done',
      '  echo "Credentials: reused the GPU machine\'s existing ones"',
      'else',
      '  set_kv MINIO_ROOT_USER "upfreq_$(rand 6)"',
      '  set_kv MINIO_ROOT_PASSWORD "$(rand 24)"',
      '  echo "Credentials: generated new ones"',
      'fi',
      'grep -q "^MINIO_ROOT_PASSWORD=minio_password$" "$ENV" && echo "WARNING: runtime.env still uses the env.example password — tell the user to change it on both machines" || true',
      'grep -q "^MINIO_ADDRESS=" "$ENV" || set_kv MINIO_ADDRESS :9000',
      'grep -q "^MINIO_CONSOLE_ADDRESS=" "$ENV" || set_kv MINIO_CONSOLE_ADDRESS :9001',
      `set_kv MINIO_BUCKET_NAME ${input.bucketName}`,
      hostLine,
      PORT_FROM_ENV,
      'set_kv GPU_MINIO_ENDPOINT "http://$GPU_HOST:$PORT"',
      'chmod 600 "$ENV"',
      'grep -E "^(MINIO_ADDRESS|MINIO_CONSOLE_ADDRESS|MINIO_BUCKET_NAME|GPU_MINIO_ENDPOINT)=" "$ENV"',
    ].join('\n'),
    verify: `Prints the non-secret settings, with GPU_MINIO_ENDPOINT pointing at the GPU machine, and \`grep -c "^MINIO_ROOT_" ${ENV_FILE}\` is 2.`,
    onFailure: 'If GPU_MINIO_ENDPOINT has the wrong host, re-run with gpuMinioHost set to the address the laptop reaches the GPU machine at.',
  }];
}

function writeProjectFilesRun(prefix: string): string {
  // prefix is '' for the laptop, or '$SSH ' to write the same files on the GPU machine.
  const dir = prefix ? '~/.upfreq/minio_sync' : PROJECT_DIR;
  return [
    `${prefix}${prefix ? `"cat > ${dir}/docker-compose.yaml"` : `cat > ${dir}/docker-compose.yaml`} <<'UPFREQ_COMPOSE'`,
    COMPOSE_YAML + 'UPFREQ_COMPOSE',
    `${prefix}${prefix ? `"cat > ${dir}/minio_init.sh"` : `cat > ${dir}/minio_init.sh`} <<'UPFREQ_INIT'`,
    MINIO_INIT_SH + 'UPFREQ_INIT',
  ].join('\n');
}

function pullImagesSteps(): SetupStep[] {
  return [{
    title: 'Pull the MinIO server and minio_sync images on the laptop',
    run: [
      `docker pull -q ${MINIO_IMAGE}`,
      `if docker pull -q ${SYNC_IMAGE}; then echo images_ok`,
      `elif docker image inspect ${SYNC_IMAGE} >/dev/null 2>&1; then echo "WARNING: could not pull ${SYNC_IMAGE} (not logged in to ghcr.io?) — continuing with the cached copy, which may be outdated"`,
      `else echo "STOP: ${SYNC_IMAGE} is a private package. Ask the user to log in themselves so their token never enters this conversation — in Claude Code: ! docker login ghcr.io -u <github-username> — with a GitHub token that has read:packages — then re-run this step."; exit 3`,
      'fi',
    ].join('\n'),
    verify: 'Prints images_ok (or the cached-copy WARNING, which you should pass on to the user).',
  }];
}

function startLocalMinioSteps(): SetupStep[] {
  return [
    {
      title: 'Write the minio_sync compose project to ~/.upfreq/minio_sync on the laptop',
      run: `mkdir -p ${PROJECT_DIR}\n${writeProjectFilesRun('')}\n${COMPOSE} config -q && echo compose_ok`,
      verify: 'Prints compose_ok.',
    },
    {
      title: 'Start MinIO on the laptop (it creates the bucket on startup)',
      run: `${COMPOSE} up -d --force-recreate minio\n${PORT_FROM_ENV}\nfor i in $(seq 30); do curl -fs -o /dev/null "http://127.0.0.1:$PORT/minio/health/live" 2>/dev/null && break; sleep 2; done\ncurl -fsS -o /dev/null -w "health %{http_code}\\n" "http://127.0.0.1:$PORT/minio/health/live"\nsleep 3; ${COMPOSE} logs minio | grep -i bucket`,
      verify: 'Prints "health 200" and a "Bucket created successfully" (or "already exists") line for the bucket.',
      onFailure: `Check \`${COMPOSE} logs minio\`. "address already in use" means something else holds the MinIO port — often an older manual minio_sync checkout; ask the user before stopping it.`,
    },
  ];
}

function setupGpuSteps(input: SshInput): SetupStep[] {
  const ssh = sshVar(input);
  return [
    {
      title: 'Create the UpFreq folders on the GPU machine',
      run: `${ssh}\n$SSH 'mkdir -p ~/.upfreq/minio_sync ~/upfreq/projects/sim_data_files && chmod 700 ~/.upfreq && echo dirs_ok'`,
      verify: 'Prints dirs_ok.',
    },
    {
      title: 'Copy the shared runtime.env to the GPU machine (refuses to replace different existing credentials)',
      run: [
        'set -e',
        ssh,
        `ENV="${ENV_FILE}"`,
        'creds_sum() { grep -E "^MINIO_ROOT_(USER|PASSWORD)=" | sort | cksum; }',
        'LOCAL_SUM=$(creds_sum < "$ENV")',
        'REMOTE_SUM=$($SSH \'cat ~/.upfreq/runtime.env 2>/dev/null\' | creds_sum)',
        'EMPTY_SUM=$(creds_sum < /dev/null)',
        'if [ "$REMOTE_SUM" != "$EMPTY_SUM" ] && [ "$REMOTE_SUM" != "$LOCAL_SUM" ]; then',
        '  echo "STOP: the GPU machine already has DIFFERENT MinIO credentials in ~/.upfreq/runtime.env. Replacing them changes the login of its existing MinIO data. Ask the user whether to overwrite the GPU machine\'s credentials with the laptop\'s (then re-run this step after moving the GPU file aside: ssh in and mv ~/.upfreq/runtime.env ~/.upfreq/runtime.env.bak), or to use the GPU machine\'s credentials on the laptop instead (move the laptop\'s runtime.env aside and re-run init_config)."',
        '  exit 3',
        'fi',
        '# Everything except GPU_MINIO_ENDPOINT, which only the laptop needs',
        'grep -v "^GPU_MINIO_ENDPOINT=" "$ENV" | $SSH \'umask 077 && cat > ~/.upfreq/runtime.env\'',
        '$SSH \'grep -c "^MINIO_ROOT_" ~/.upfreq/runtime.env; grep "^MINIO_BUCKET_NAME=" ~/.upfreq/runtime.env\'',
      ].join('\n'),
      verify: 'Prints 2 and the MINIO_BUCKET_NAME line.',
    },
    {
      title: 'Write the same minio_sync compose project on the GPU machine',
      run: `${ssh}\n${writeProjectFilesRun('$SSH ')}\n$SSH '${REMOTE_COMPOSE} config -q && echo compose_ok'`,
      verify: 'Prints compose_ok.',
    },
    {
      title: 'Pull MinIO and start it on the GPU machine (only the minio service — the sync runs on the laptop)',
      run: `${ssh}\n$SSH '${REMOTE_COMPOSE} pull minio && ${REMOTE_COMPOSE} up -d --force-recreate minio && sleep 5 && ${REMOTE_COMPOSE} logs minio | grep -i bucket'`,
      verify: 'Shows a "Bucket created successfully" (or "already exists") line for the bucket.',
      onFailure: `Check \`$SSH '${REMOTE_COMPOSE} logs minio'\`. "address already in use": something else on the GPU machine holds the MinIO port — ask the user before stopping it.`,
    },
  ];
}

function startSyncSteps(input: { allowGpuDeletes: boolean }): SetupStep[] {
  const guard = input.allowGpuDeletes
    ? 'echo "objects only in the GPU bucket: $n (user approved deleting them)"'
    : [
        'echo "objects only in the GPU bucket: $n"',
        'if [ "$n" -gt 0 ]; then',
        '  mc diff "l/$B" "g/$B" | grep "^>" | head -20',
        '  echo "STOP: the sync mirrors with --remove, so starting it DELETES these $n object(s) that exist only in the GPU bucket. Ask the user to choose: (a) copy them to the laptop first (run the copyGpuOnlyObjects command from this tool result, then re-run this step), or (b) let them be deleted (call start_sync again with allowGpuDeletes: true)."',
        '  exit 3',
        'fi',
      ].join('\n');

  return [
    {
      title: 'Check the laptop can reach the GPU machine\'s MinIO',
      run: `GPU_EP=$(sed -n 's/^GPU_MINIO_ENDPOINT=//p' "${ENV_FILE}")\ncurl -fsS -m 10 -o /dev/null -w "gpu health %{http_code}\\n" "$GPU_EP/minio/health/live"`,
      verify: 'Prints "gpu health 200".',
      onFailure: 'Timeout / connection refused: MinIO isn\'t up on the GPU machine, or its firewall blocks the port from the laptop (ask the user before changing firewall rules, e.g. `sudo ufw allow from <laptop-ip> to any port 9000`), or the laptop reaches it at another address — re-run init_config with gpuMinioHost (e.g. its Tailscale IP).',
    },
    {
      title: 'Safety check: find objects only in the GPU bucket (the sync would delete them)',
      run: withMc(['n=$(mc diff "l/$B" "g/$B" | grep -c "^>" || true)', guard].join('\n')),
      verify: 'Prints "objects only in the GPU bucket: 0" (or the user approved deleting them).',
      onFailure: 'An "Access Denied"/"invalid credentials" error means the two MinIO servers don\'t share the same credentials — re-run setup_gpu_minio.',
    },
    {
      title: 'Start the minio_gpu_sync container on the laptop',
      run: `${COMPOSE} --profile sync up -d --force-recreate minio_gpu_sync\nsleep 8; docker logs --tail 20 minio_gpu_sync`,
      verify: 'Logs end with "[INFO] Mirroring local_minio/<bucket> -> gpu_minio/<bucket>" and no errors. Repeating "Waiting for ..." lines mean a server or bucket isn\'t reachable yet.',
    },
    {
      title: 'End-to-end check: upload a test object to the laptop bucket and confirm it reaches the GPU bucket',
      run: withMc([
        'echo "upfreq sync check $(date)" | mc pipe "l/$B/.upfreq-sync-check.txt" >/dev/null',
        'for i in $(seq 15); do mc stat "g/$B/.upfreq-sync-check.txt" >/dev/null 2>&1 && break; sleep 2; done',
        'mc stat "g/$B/.upfreq-sync-check.txt" >/dev/null 2>&1 && echo "sync_ok: object reached the GPU bucket" || { echo "sync_failed: object did not reach the GPU bucket in 30s"; exit 1; }',
        'mc rm "l/$B/.upfreq-sync-check.txt" >/dev/null',
      ].join('\n')),
      verify: 'Prints sync_ok.',
      onFailure: 'Check `docker logs --tail 50 minio_gpu_sync` for mc errors.',
    },
  ];
}

const COPY_GPU_ONLY_OBJECTS = withMc('mc mirror "g/$B" "l/$B"');

function statusSteps(input: Partial<SshInput>): SetupStep[] {
  const steps: SetupStep[] = [
    {
      title: 'Laptop containers and sync log',
      run: 'docker ps -a --filter name=minio --format "{{.Names}}\\t{{.Status}}"\ndocker logs --tail 15 minio_gpu_sync 2>&1',
      verify: 'minio and minio_gpu_sync are "Up"; the log ends with the "Mirroring ..." line or recent transfers, not "Waiting for ...".',
    },
    {
      title: 'Object counts in the laptop and GPU buckets',
      run: withMc('echo "laptop: $(mc du "l/$B" | tail -1)"\necho "gpu:    $(mc du "g/$B" | tail -1)"'),
      verify: 'Both show the same object count and size (the GPU side can lag briefly while transfers run).',
    },
  ];
  if (input.sshTarget) {
    const ssh = sshVar({ sshTarget: input.sshTarget, sshPort: input.sshPort ?? 22, sshKeyPath: input.sshKeyPath });
    steps.push({
      title: 'GPU machine MinIO container',
      run: `${ssh}\n$SSH 'docker ps -a --filter name=minio --format "{{.Names}}\\t{{.Status}}"'`,
      verify: 'The minio container is "Up".',
    });
  }
  return steps;
}

const USAGE_NOTE =
  'To add simulation data, upload it through MinIO (web console on http://127.0.0.1:9001, `mc`, or any S3 client with the credentials in ~/.upfreq/runtime.env) — ' +
  'files copied straight into ~/upfreq/projects/sim_data_files are not picked up, since MinIO stores objects in its own format there. ' +
  'Anything deleted from the laptop bucket is also deleted from the GPU bucket.';

export const setupSimSyncAction: AgentNativeAction = {
  id: `${NS}.setup_sim_sync`,
  namespace: NS,
  name: 'setup_sim_sync',
  description:
    'Start here when the user asks to "set up sim sync", "set up simulation data sync" or "sync my sim data to the GPU machine". ' +
    'Returns the full, ordered runbook that you then execute yourself on the laptop: checks Docker, SSH into the GPU machine, creates ~/.upfreq, the data folder and ~/.upfreq/runtime.env (shared MinIO credentials), pulls the images, ' +
    'starts MinIO on the laptop, sets up and starts MinIO on the GPU machine over SSH, then starts minio_gpu_sync on the laptop and verifies an object reaches the GPU bucket. ' +
    'Safe to re-run: it keeps existing credentials and data. Needs sshTarget — if you don\'t know the GPU machine\'s SSH destination, ask the user for it first.',
  defaultPolicy: 'ALLOWED',
  schema: z.object({ ...sshFields, ...configFields, ...syncFields }),
  async execute(input) {
    return {
      ...plan([
        ...laptopPreflightSteps(),
        ...gpuSshSteps(input),
        ...initConfigSteps(input),
        ...pullImagesSteps(),
        ...startLocalMinioSteps(),
        ...setupGpuSteps(input),
        ...startSyncSteps(input),
      ]),
      copyGpuOnlyObjects: COPY_GPU_ONLY_OBJECTS,
      whenDone: `Tell the user the sync is running, where the web consoles are (laptop http://127.0.0.1:9001, GPU http://<gpu-host>:9001, login in ~/.upfreq/runtime.env), and: ${USAGE_NOTE}`,
    };
  },
};

export const checkGpuSshAction: AgentNativeAction = {
  id: `${NS}.check_gpu_ssh`,
  namespace: NS,
  name: 'check_gpu_ssh',
  description: 'Checks the laptop can SSH into the GPU machine non-interactively and that it has Docker, Docker Compose and an NVIDIA GPU. One phase of setup_sim_sync, for re-running on its own.',
  defaultPolicy: 'ALLOWED',
  schema: z.object(sshFields),
  async execute(input) {
    return plan(gpuSshSteps(input), `Next: ${NS}.init_config`);
  },
};

export const initConfigAction: AgentNativeAction = {
  id: `${NS}.init_config`,
  namespace: NS,
  name: 'init_config',
  description:
    'On the laptop: creates ~/.upfreq, ~/upfreq/projects/sim_data_files and ~/.upfreq/runtime.env. Keeps existing laptop credentials, else reuses the GPU machine\'s, else generates new ones; sets MINIO_BUCKET_NAME and GPU_MINIO_ENDPOINT. ' +
    'One phase of setup_sim_sync, for re-running on its own (e.g. to change the bucket or the GPU address).',
  defaultPolicy: 'ALLOWED',
  schema: z.object({ ...sshFields, ...configFields }),
  async execute(input) {
    return plan(initConfigSteps(input), `Next: ${NS}.pull_images`);
  },
};

export const pullImagesAction: AgentNativeAction = {
  id: `${NS}.pull_images`,
  namespace: NS,
  name: 'pull_images',
  description: `On the laptop: checks Docker/Compose and pulls ${MINIO_IMAGE} and the private ${SYNC_IMAGE} (needs \`docker login ghcr.io\`). One phase of setup_sim_sync, for re-running on its own.`,
  defaultPolicy: 'ALLOWED',
  schema: z.object({}),
  async execute() {
    return plan([...laptopPreflightSteps(), ...pullImagesSteps()], `Next: ${NS}.start_local_minio`);
  },
};

export const startLocalMinioAction: AgentNativeAction = {
  id: `${NS}.start_local_minio`,
  namespace: NS,
  name: 'start_local_minio',
  description: 'On the laptop: writes the minio_sync compose project to ~/.upfreq/minio_sync and starts MinIO, which creates the bucket on startup. One phase of setup_sim_sync, for re-running on its own.',
  defaultPolicy: 'ALLOWED',
  schema: z.object({}),
  async execute() {
    return plan(startLocalMinioSteps(), `Next: ${NS}.setup_gpu_minio`);
  },
};

export const setupGpuMinioAction: AgentNativeAction = {
  id: `${NS}.setup_gpu_minio`,
  namespace: NS,
  name: 'setup_gpu_minio',
  description:
    'Over SSH: creates the folders on the GPU machine, copies the laptop\'s runtime.env there (refusing to replace different existing credentials), writes the same compose project, pulls MinIO and starts it. ' +
    `Needs ${NS}.init_config to have run on the laptop. One phase of setup_sim_sync, for re-running on its own.`,
  defaultPolicy: 'ALLOWED',
  schema: z.object(sshFields),
  async execute(input) {
    return plan(setupGpuSteps(input), `Next: ${NS}.start_sync`);
  },
};

export const startSyncAction: AgentNativeAction = {
  id: `${NS}.start_sync`,
  namespace: NS,
  name: 'start_sync',
  description:
    'On the laptop: checks the GPU machine\'s MinIO is reachable, refuses to start if the sync\'s --remove would delete objects that exist only in the GPU bucket (unless allowGpuDeletes), starts minio_gpu_sync and verifies a test object reaches the GPU bucket. ' +
    'One phase of setup_sim_sync, for re-running on its own.',
  defaultPolicy: 'ALLOWED',
  schema: z.object(syncFields),
  async execute(input) {
    return { ...plan(startSyncSteps(input)), copyGpuOnlyObjects: COPY_GPU_ONLY_OBJECTS, note: USAGE_NOTE };
  },
};

export const checkStatusAction: AgentNativeAction = {
  id: `${NS}.check_status`,
  namespace: NS,
  name: 'check_status',
  description: 'Use when the user asks whether sim sync is working: checks the laptop\'s MinIO and minio_gpu_sync containers, the sync log, and compares object counts in the laptop and GPU buckets (plus the GPU machine\'s container, if sshTarget is given).',
  defaultPolicy: 'ALLOWED',
  schema: z.object({
    sshTarget: sshFields.sshTarget.optional(),
    sshPort: sshFields.sshPort,
    sshKeyPath: sshFields.sshKeyPath,
  }),
  async execute(input) {
    return plan(statusSteps(input));
  },
};

export const simulationDataSyncSetupActions = [
  setupSimSyncAction,
  checkGpuSshAction,
  initConfigAction,
  pullImagesAction,
  startLocalMinioAction,
  setupGpuMinioAction,
  startSyncAction,
  checkStatusAction,
];
