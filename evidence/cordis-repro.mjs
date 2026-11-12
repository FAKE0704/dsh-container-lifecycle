// Minimal repro: does a runtime-inserted class service wake parked inject consumers?
// Mirrors the A1 structure: async apply → delay → ctx.plugin(SshConnection-like class).
import { Context } from '@deepseek-ai/cordis'

const wakeLog = []

class LateService {
  static inject = []
  constructor(ctx) {
    this.ctx = ctx
    ctx.reflect.provide('late', this)
  }
  async [Symbol.for('cordis.init')]() { wakeLog.push('late-init') }
}

const consumer = {
  name: 'consumer',
  inject: ['late'],
  apply(ctx) {
    wakeLog.push('consumer-awake')
    ctx.reflect.provide('consumerReady', { ok: true })
  },
}

const producer = {
  name: 'producer',
  inject: [],
  async apply(ctx) {
    wakeLog.push(`producer-apply t=${Date.now() - t0}ms`)
    await new Promise((resolve) => { setTimeout(resolve, 300) })
    ctx.plugin(LateService, {})
    wakeLog.push(`producer-inserted t=${Date.now() - t0}ms`)
  },
}

const t0 = Date.now()
const app = new Context({})
app.plugin(producer, {})
app.plugin(consumer, {})
await new Promise((resolve) => { setTimeout(resolve, 1000) })
console.log(wakeLog.join('\n'))
console.log('consumer awake:', wakeLog.includes('consumer-awake') ? 'YES' : 'NO')
