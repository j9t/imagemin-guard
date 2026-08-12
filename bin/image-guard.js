#!/usr/bin/env node

import { styleText } from 'node:util'
import { runImageGuard } from '../src/index.js'

try {
  await runImageGuard()
} catch (err) {
  if (err.setupFailed) {
    console.error(styleText('red', err.message))
  } else {
    console.error('Error running Image Guard:', err)
  }
  process.exit(1)
}