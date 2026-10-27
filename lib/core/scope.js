// Project identity: the nearest Git root, the working directory, or an explicit root.
import { realpath, stat, access } from 'node:fs/promises'
import { dirname, resolve, relative, isAbsolute, sep } from 'node:path'
import { homedir } from 'node:os'

export const inside = (root, path) => { const p = relative(root, path); return p !== '' && p !== '..' && !p.startsWith(`..${sep}`) && !isAbsolute(p) }

export async function projectScope(cwd, { projectRoot: explicit = '', home = homedir() } = {}) {
  const start = await realpath(cwd)
  if (!(await stat(start)).isDirectory()) throw new Error('Working directory is not a directory')
  if (explicit) {
    if (!isAbsolute(explicit)) throw new Error('projectRoot must be absolute')
    const root = await realpath(explicit)
    if (!(await stat(root)).isDirectory()) throw new Error('projectRoot must be a directory')
    if (relative(root, start) === '' || inside(root, start)) return { project: root, source: 'explicit' }
  }
  const userHome = await realpath(home).catch(() => home)
  let dir = start
  while (true) {
    const parent = dirname(dir)
    // A repository at the home or filesystem root would merge unrelated directories.
    const broad = parent === dir || relative(userHome, dir) === ''
    try {
      await access(resolve(dir, '.git'))
      return broad ? { project: start, source: 'cwd', warning: 'broad-git-root-ignored', ignored_git_root: dir }
        : { project: dir, source: 'git' }
    } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error }
    if (broad) return { project: start, source: 'cwd' }
    dir = parent
  }
}

export async function projectRoot(cwd, options) { return (await projectScope(cwd, options)).project }
