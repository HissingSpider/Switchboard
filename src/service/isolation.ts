import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, statSync } from 'node:fs';

const exec = promisify(execFile);

export const WORKER_USER = 'swbworker';

export interface IsolationStatus {
  userExists: boolean;
  isAdmin: boolean;
  homeDir?: string;
  projectsDir?: string;
  problems: string[];
}

/**
 * Worker isolation.
 *
 * Full-auto agents run as a separate non-admin macOS user whose reach is
 * ~/projects and nothing else. That way "bypassPermissions" means "can do
 * anything a limited user can do", not "can do anything on this Mac". The
 * daemon itself stays as the owner so it can still text and read the Keychain.
 *
 * Creating the user needs sudo, so we generate the script rather than run it.
 */
export async function isolationStatus(): Promise<IsolationStatus> {
  const problems: string[] = [];
  let userExists = false;
  let isAdmin = false;
  let homeDir: string | undefined;

  try {
    const { stdout } = await exec('dscl', ['.', '-read', `/Users/${WORKER_USER}`, 'NFSHomeDirectory']);
    userExists = true;
    homeDir = stdout.split(':').pop()?.trim();
  } catch {
    problems.push(`worker user "${WORKER_USER}" does not exist — runs execute as the owner`);
  }

  if (userExists) {
    try {
      const { stdout } = await exec('dscl', ['.', '-read', '/Groups/admin', 'GroupMembership']);
      isAdmin = stdout.includes(WORKER_USER);
      if (isAdmin) problems.push(`"${WORKER_USER}" is in the admin group — remove it`);
    } catch {
      /* group read failed; not fatal */
    }
  }

  const projectsDir = homeDir ? `${homeDir}/projects` : undefined;
  if (projectsDir && !existsSync(projectsDir)) problems.push(`${projectsDir} does not exist`);
  if (projectsDir && existsSync(projectsDir)) {
    const mode = statSync(projectsDir).mode & 0o777;
    if (mode & 0o002) problems.push(`${projectsDir} is world-writable (mode ${mode.toString(8)})`);
  }

  return { userExists, isAdmin, homeDir, projectsDir, problems };
}

/** Printable setup script. Read it before running it — it creates a user. */
export function setupScript(uid = 601): string {
  return `#!/bin/bash
# Create the unattended worker account. Run with sudo, once.
set -euo pipefail

USER_NAME=${WORKER_USER}
UID_NUM=${uid}
HOME_DIR=/Users/$USER_NAME

if dscl . -read /Users/$USER_NAME >/dev/null 2>&1; then
  echo "$USER_NAME already exists"
else
  dscl . -create /Users/$USER_NAME
  dscl . -create /Users/$USER_NAME UserShell /bin/zsh
  dscl . -create /Users/$USER_NAME RealName "Switchboard Worker"
  dscl . -create /Users/$USER_NAME UniqueID $UID_NUM
  dscl . -create /Users/$USER_NAME PrimaryGroupID 20
  dscl . -create /Users/$USER_NAME NFSHomeDirectory $HOME_DIR
  # No password: this account is never logged into interactively.
  dscl . -create /Users/$USER_NAME Password '*'
  createhomedir -c -u $USER_NAME >/dev/null
fi

# Deliberately NOT added to the admin group.
dseditgroup -o edit -d $USER_NAME -t user admin 2>/dev/null || true

mkdir -p $HOME_DIR/projects
chown -R $USER_NAME:staff $HOME_DIR/projects
chmod 750 $HOME_DIR/projects

# Hide it from the login window.
dscl . -create /Users/$USER_NAME IsHidden 1

echo "done. Worker home: $HOME_DIR, workspace: $HOME_DIR/projects"
echo "Point Switchboard projects at $HOME_DIR/projects/<repo> and grant the daemon"
echo "the right to run as $USER_NAME (sudo -u $USER_NAME) via /etc/sudoers.d/switchboard."
`;
}

export function sudoersSnippet(ownerUser = process.env.USER ?? 'owner'): string {
  return [
    '# /etc/sudoers.d/switchboard — visudo -f this file, do not edit it directly.',
    `${ownerUser} ALL=(${WORKER_USER}) NOPASSWD: /usr/bin/env, /bin/zsh, /usr/local/bin/claude`,
  ].join('\n');
}

/** Wrap a command so it executes as the worker user. */
export function asWorker(command: string, args: string[]): { command: string; args: string[] } {
  return { command: 'sudo', args: ['-n', '-u', WORKER_USER, command, ...args] };
}
