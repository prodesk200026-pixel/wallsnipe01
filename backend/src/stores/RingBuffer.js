/**
 * Fixed-capacity ring buffer. Oldest entries are overwritten once
 * capacity is reached — used for every rolling window (1s..5m) so
 * the rolling store cannot grow without bound.
 */
export class RingBuffer {
  constructor(capacity) {
    this.capacity = capacity;
    this._buf = new Array(capacity);
    this._start = 0;
    this._length = 0;
  }

  push(item) {
    const idx = (this._start + this._length) % this.capacity;
    this._buf[idx] = item;
    if (this._length < this.capacity) {
      this._length++;
    } else {
      this._start = (this._start + 1) % this.capacity;
    }
  }

  toArray() {
    const out = new Array(this._length);
    for (let i = 0; i < this._length; i++) {
      out[i] = this._buf[(this._start + i) % this.capacity];
    }
    return out;
  }

  get length() {
    return this._length;
  }

  last() {
    if (this._length === 0) return null;
    return this._buf[(this._start + this._length - 1) % this.capacity];
  }

  sinceMs(ms, now = Date.now()) {
    return this.toArray().filter((item) => item && now - item.timestamp <= ms);
  }

  clear() {
    this._start = 0;
    this._length = 0;
  }
}
