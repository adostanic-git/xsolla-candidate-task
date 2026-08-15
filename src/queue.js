// Concurrency-limited job queue. At least `limit` jobs process at once;
// anything beyond that waits without failing.
class ConcurrentQueue {
  constructor(limit) {
    this.limit = limit;
    this.active = 0;
    this.pending = [];
  }

  push(task) {
    this.pending.push(task);
    this._drain();
  }

  _drain() {
    while (this.active < this.limit && this.pending.length > 0) {
      const task = this.pending.shift();
      this.active++;
      Promise.resolve()
        .then(task)
        .catch((err) => {
          // Tasks are expected to handle their own errors internally
          // (mark the job "failed"); this is a last-resort safety net so a
          // bug here can never take down the process or the queue.
          console.error('unhandled queue task error:', err);
        })
        .finally(() => {
          this.active--;
          this._drain();
        });
    }
  }
}

module.exports = { ConcurrentQueue };
