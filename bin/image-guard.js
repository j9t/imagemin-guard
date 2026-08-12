#!/usr/bin/env node

import { runImageGuard } from '../src/index.js'
import { styleStderr } from '../src/utils.js'

try {
  await runImageGuard()
} catch (err) {
  if (err.setupFailed) {
    console.error(styleStderr('red', err.message))
  } else {
    console.error('Error running Image Guard:', err)
  }
  process.exit(1)
}