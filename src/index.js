// This file, which had been forked from imagemin-merlin, was modified for imagemin-guard: https://github.com/sumcumo/imagemin-merlin/compare/master...j9t:master

import { globby } from 'globby'
import simpleGit from 'simple-git'
import { parseArgs, styleText } from 'node:util'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { utils } from './utils.js'

// Files to be compressed
export const fileTypes = ['avif', 'gif', 'jpg', 'jpeg', 'png', 'webp'];

export async function runImageminGuard() {
  const options = {
    dry: { type: 'boolean', default: false },
    ignore: { type: 'string', multiple: false, default: '' },
    staged: { type: 'boolean', default: false },
    quiet: { type: 'boolean', default: false }
  }
  const { values: argv } = parseArgs({ options })

  // Share status
  const summary = (run) => {
    if (run) {
      console.info(styleText(['bold'], `\nDefensive base compression completed. You saved ${utils.sizeReadable(savedKB)}.`))
    } else {
      console.info(styleText(['bold'], 'There were no images to compress.'))
    }
  }

  if (!argv.quiet) {
    console.log(`(Search pattern: ${fileTypes.join(', ')})\n`)
  }

  let savedKB = 0

  // Tiny in-house concurrency limiter
  const createLimiter = (concurrency) => {
    let active = 0
    const queue = []
    let head = 0 // Index-based queue head to avoid O(n) shift

    const maybeCompact = () => {
      // Compact when a lot of items have been consumed to avoid unbounded growth
      // Heuristic: When head is large and at least half was consumed
      if (head > 1024 && head >= (queue.length - head)) {
        queue.splice(0, head)
        head = 0
      }
    }

    const next = () => {
      if (active >= concurrency) return
      if (head >= queue.length) return
      active++
      const { fn, resolve, reject } = queue[head++]
      Promise.resolve()
        .then(fn)
        .then(resolve, reject)
        .finally(() => {
          active--
          maybeCompact()
          next()
        })
    }
    return fn => new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject })
      next()
    })
  }

  const compress = async (files, dry) => {
    if (files.length === 0) {
      summary(false)
      return
    }

    const desiredFileConcurrency = Math.min(os.cpus().length, 4)
    // Tune libvips threads to avoid oversubscription
    const perTaskThreads = Math.max(1, Math.floor(os.cpus().length / Math.max(1, desiredFileConcurrency)))
    try {
      sharp.concurrency(perTaskThreads)
    } catch {
      // Best-effort; ignore if not supported
    }

    const limit = createLimiter(desiredFileConcurrency)
    const tasks = files.map(file => limit(() => utils.compression(file, dry, argv.quiet)))
    const results = await Promise.allSettled(tasks)
    for (const r of results) {
      if (r.status === 'fulfilled' && typeof r.value === 'number') {
        savedKB += r.value
      }
    }

    summary(true)
  }

  const getFilePattern = (ignore) => {
    const patterns = []

    // Rely on `caseSensitiveMatch: false` instead of duplicating upper/lower-case
    for (const fileType of fileTypes) {
      patterns.push(`**/*.${fileType}`)
    }

    const ignoreList = (ignore || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)

    for (const p of ignoreList) {
      patterns.push(p.startsWith('!') ? p : `!${p}`)
    }

    return patterns
  }

  const findFiles = async (patterns, options = {}) => {
    return globby(patterns, {
      gitignore: true,
      onlyFiles: true,
      caseSensitiveMatch: false,
      ...options
    })
  }

  const patterns = getFilePattern(argv.ignore)
  let files = []
  let compressionFiles = []

  // Search for staged files
  if (argv.staged) {
    const git = simpleGit()
    try {
      // Get staged file paths directly from Git
      const diffOutput = await git.raw(['diff', '--name-only', '--cached', '--diff-filter=ACMRT'])
      const stagedFiles = diffOutput.split('\n').map(s => s.trim()).filter(Boolean)
      // Filter by allowed extensions
      const allowedExts = new Set(fileTypes)
      const byExt = stagedFiles.filter(f => allowedExts.has(path.extname(f).slice(1).toLowerCase()))
      // Apply `--ignore` using the same glob semantics as non-staged by delegating to globby
      const ignoreList = (argv.ignore || '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
        .map(p => (p.startsWith('!') ? p : `!${p}`))

      if (ignoreList.length > 0) {
        // Use globby to filter the staged list with identical options; avoid repo-wide scan
        // Pass the staged file paths as include patterns and the ignores as negatives
        const filtered = await globby([...byExt, ...ignoreList], {
          gitignore: true,
          expandDirectories: false,
          onlyFiles: true,
          caseSensitiveMatch: false
        })
        compressionFiles = filtered
      } else {
        compressionFiles = byExt
      }
      await compress(compressionFiles, argv.dry)
    } catch (err) {
      console.error(err)
    }
  } else {
    files = await findFiles(patterns)
    compressionFiles = files
    await compress(compressionFiles, argv.dry)
  }
}