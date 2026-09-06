import { execFile } from 'node:child_process'
import { rm } from 'node:fs/promises'
import { promisify } from 'node:util'

const run = promisify(execFile)

const GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0', // never block CI on a credential prompt
  GIT_ASKPASS: 'echo',
  GIT_CONFIG_NOSYSTEM: '1',
}

/**
 * Resolve a remote's HEAD commit without cloning. Works for any git host, which
 * matters because omarchy-theme-install accepts any git URL, not just GitHub.
 */
export async function remoteHead(url) {
  const { stdout } = await run('git', ['ls-remote', '--symref', url, 'HEAD'], {
    env: GIT_ENV,
    timeout: 60_000,
  })

  const sha = stdout.match(/^([0-9a-f]{40})\s+HEAD$/m)?.[1] ?? null
  const branch = stdout.match(/^ref:\s+refs\/heads\/(\S+)\s+HEAD$/m)?.[1] ?? null
  if (!sha) throw new Error(`could not resolve HEAD for ${url}`)
  return { sha, branch }
}

export async function shallowClone(url, dest, { blobLimit = null } = {}) {
  const attempt = async (useFilter) => {
    const args = ['clone', '--depth', '1', '--single-branch', '--quiet']
    if (useFilter && blobLimit) args.push(`--filter=blob:limit=${blobLimit}`)
    args.push(url, dest)
    await run('git', args, {
      env: GIT_ENV,
      timeout: 180_000,
      maxBuffer: 16 * 1024 * 1024,
    })
  }

  try {
    await attempt(Boolean(blobLimit))
  } catch (err) {
    // Partial clone is a GitHub/GitLab thing. A host that doesn't speak
    // `--filter` should still be inspectable — fall back to a full shallow clone.
    if (!blobLimit) throw err
    await rm(dest, { recursive: true, force: true })
    await attempt(false)
  }

  const { stdout } = await run('git', ['-C', dest, 'rev-parse', 'HEAD'], { env: GIT_ENV })
  return stdout.trim()
}

export async function lastCommitDate(dir) {
  const { stdout } = await run('git', ['-C', dir, 'log', '-1', '--format=%cI'], { env: GIT_ENV })
  return stdout.trim() || null
}
