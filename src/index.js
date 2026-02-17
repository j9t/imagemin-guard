// This file, which had been forked from imagemin-merlin, was modified for image-guard: https://github.com/sumcumo/imagemin-merlin/compare/master...j9t:master

import { globby, convertPathToPattern } from 'globby'
import simpleGit from 'simple-git'
import { parseArgs, styleText } from 'node:util'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { utils } from './utils.js'

// Files to be compressed
export const fileTypes = ['avif', 'gif', 'jpg', 'jpeg', 'png', 'webp'];

// Files to be converted (require explicit opt-in)
export const convertTypes = ['heic', 'heif'];

export async function runImageGuard() {
  const options = {
    dry: { type: 'boolean', default: false },
    'heic-to-avif': { type: 'boolean', default: false },
    ignore: { type: 'string', multiple: false, default: '' },
    'keep-heic': { type: 'boolean', default: false },
    staged: { type: 'boolean', default: false },
    quiet: { type: 'boolean', default: false }
  }
  const { values: argv } = parseArgs({ options })

  // Share status
  const summary = (run, includesConversion = false) => {
    if (run) {
      const action = includesConversion ? 'compression and conversion' : 'compression'
      console.info(styleText(['bold'], `\nDefensive base ${action} completed. You saved ${utils.sizeReadable(savedKB)}.`))
    } else {
      const what = includesConversion ? 'images to compress or convert' : 'images to compress'
      console.info(styleText(['bold'], `There were no ${what}.`))
    }
  }

  if (argv['keep-heic'] && !argv['heic-to-avif']) {
    console.warn(styleText('yellow', '`--keep-heic` has no effect without `--heic-to-avif`'))
  }

  const allTypes = argv['heic-to-avif'] ? [...fileTypes, ...convertTypes] : fileTypes
  if (!argv.quiet) {
    console.log(`(Search pattern: ${allTypes.join(', ')})\n`)
  }

  let savedKB = 0

  // Tiny in-house concurrency limiter
  const createLimiter = (concurrency) => {
    concurrency = Math.max(1, Number(concurrency) || 1)
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

  const desiredFileConcurrency = Math.min(os.cpus().length, 4)
  const perTaskThreads = Math.max(1, Math.floor(os.cpus().length / Math.max(1, desiredFileConcurrency)))
  try {
    sharp.concurrency(perTaskThreads)
  } catch {
    // Best-effort; ignore if not supported
  }
  const limit = createLimiter(desiredFileConcurrency)

  const processResults = (results) => {
    let hadFailures = false
    for (const r of results) {
      if (r.status === 'fulfilled') {
        if (typeof r.value === 'number') {
          savedKB += r.value
        } else {
          hadFailures = true
        }
      } else {
        hadFailures = true
        const reason = r.reason && r.reason.message ? r.reason.message : String(r.reason)
        console.error(styleText('red', 'Task failed:'), reason)
      }
    }
    return hadFailures
  }

  const compress = async (files, dry) => {
    if (files.length === 0) return false

    const tasks = files.map(file => limit(() => utils.compression(file, dry, argv.quiet)))
    const results = await Promise.allSettled(tasks)

    return processResults(results)
  }

  const convert = async (files, dry, keepOriginal) => {
    if (files.length === 0) return false

    const tasks = files.map(file => limit(() => utils.conversion(file, dry, keepOriginal, argv.quiet)))
    const results = await Promise.allSettled(tasks)

    return processResults(results)
  }

  const getIgnorePatterns = (ignore) => {
    return (ignore || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
      .map(p => (p.startsWith('!') ? p : `!${p}`))
  }

  const getFilePattern = (ignore, types = fileTypes) => {
    const patterns = []

    // Rely on `caseSensitiveMatch: false` instead of duplicating upper/lower-case
    for (const fileType of types) {
      patterns.push(`**/*.${fileType}`)
    }

    for (const p of getIgnorePatterns(ignore)) {
      patterns.push(p)
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

  const filterStagedFiles = async (stagedFiles, types) => {
    const allowedExts = new Set(types)
    const byExt = stagedFiles.filter(f => allowedExts.has(path.extname(f).slice(1).toLowerCase()))
    const ignoreList = getIgnorePatterns(argv.ignore)

    if (ignoreList.length > 0) {
      const escapedPaths = byExt.map(p => convertPathToPattern(p))
      return globby([...escapedPaths, ...ignoreList], {
        gitignore: true,
        expandDirectories: false,
        onlyFiles: true,
        caseSensitiveMatch: false
      })
    }
    return byExt
  }

  const doConversion = argv['heic-to-avif']
  let hadFailures = false
  let totalFiles = 0

  if (argv.staged) {
    const git = simpleGit()
    try {
      const diffOutput = await git.raw(['diff', '--name-only', '--cached', '--diff-filter=ACMRT'])
      const stagedFiles = diffOutput.split('\n').map(s => s.trim()).filter(Boolean)

      const compressionFiles = await filterStagedFiles(stagedFiles, fileTypes)
      totalFiles += compressionFiles.length
      hadFailures = await compress(compressionFiles, argv.dry)

      if (doConversion) {
        const conversionFiles = await filterStagedFiles(stagedFiles, convertTypes)
        totalFiles += conversionFiles.length
        const convFailed = await convert(conversionFiles, argv.dry, argv['keep-heic'])
        hadFailures = hadFailures || convFailed
      }
    } catch (err) {
      console.error(err)
      hadFailures = true
    }
  } else {
    const patterns = getFilePattern(argv.ignore)
    const compressionFiles = await findFiles(patterns)
    totalFiles += compressionFiles.length
    hadFailures = await compress(compressionFiles, argv.dry)

    if (doConversion) {
      const convPatterns = getFilePattern(argv.ignore, convertTypes)
      const conversionFiles = await findFiles(convPatterns)
      totalFiles += conversionFiles.length
      const convFailed = await convert(conversionFiles, argv.dry, argv['keep-heic'])
      hadFailures = hadFailures || convFailed
    }
  }

  if (hadFailures) {
    process.exitCode = 1
    if (totalFiles > 0 && savedKB > 0) {
      const action = doConversion ? 'compression and conversion' : 'compression'
      console.info(styleText(['bold'], `\nDefensive base ${action} partially completed (some tasks failed). You saved ${utils.sizeReadable(savedKB)}.`))
    } else {
      summary(false, doConversion)
    }
  } else if (totalFiles > 0) {
    summary(true, doConversion)
  } else {
    summary(false, doConversion)
  }
}