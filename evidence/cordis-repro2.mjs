// Second-order wake repro: producer → (delay) → 'late' service → middle fiber
// consumes 'late', provides 'mid' → consumer fiber consumes 'mid'. Does the
// chain propagate when every link is a loader-style fiber?
import { Context } from '@deepseek-ai/cordis'

const wakeLog = []

class LateService {
  constructor(ctx) { this.ctx = ctx; ctx.reflect.provide('late', this) }
}
class MidService {
  constructor(ctx) { this.ctx = ctx; ctx.reflect.provide('mid', this) }
}

const producer = {
  name: 'producer',
  async apply(ctx) {
    wakeLog.push('producer-apply')
    await new Promise((resolve) => { setTimeout(resolve, 300) })
    ctx.plugin(LateService, {})
    wakeLog.push('producer-inserted')
  },
}
const middle = {
  name: 'middle',
  inject: ['late'],
  apply(ctx) {
    wakeLog.push('middle-awake')
    ctx.plugin(MidService, {})
  },
}
const consumer = {
  name: 'consumer',
  inject: ['mid'],
  apply(ctx) { wakeLog.push('consumer-awake') },
}

const app = new Context({})
app.plugin(producer, {})
app.plugin(middle, {})
app.plugin(consumer, {})
await new Promise((resolve) => { setTimeout(resolve, 1200) })
console.log(wakeLog.join('\n'))
console.log('middle awake:', wakeLog.includes('middle-awake') ? 'YES' : 'NO')
console.log('consumer awake (second-order):', wakeLog.includes('consumer-awake') ? 'YES' : 'NO')
