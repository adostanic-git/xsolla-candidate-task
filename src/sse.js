const { EventEmitter } = require('events');

// Per-job event log (for replay) + live emitter (for in-progress streaming).
class JobEventChannel extends EventEmitter {
  constructor() {
    super();
    this.log = []; // [{event, data}] in emission order
    this.closed = false;
  }

  emitEvent(event, data) {
    if (this.closed) return;
    const entry = { event, data };
    this.log.push(entry);
    this.emit('event', entry);
    if (event === 'done' || (event === 'status' && data.status === 'failed')) {
      this.closed = true;
      this.emit('close');
    }
  }
}

const channels = new Map(); // jobId -> JobEventChannel

function getOrCreateChannel(jobId) {
  let ch = channels.get(jobId);
  if (!ch) {
    ch = new JobEventChannel();
    channels.set(jobId, ch);
  }
  return ch;
}

module.exports = { getOrCreateChannel };
