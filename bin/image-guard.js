#!/usr/bin/env node

import { runImageGuard } from '../src/index.js'

try {
  await runImageGuard()
} catch (err) {
  console.error('Error running Image Guard:', err.message)
  process.exit(1)
}