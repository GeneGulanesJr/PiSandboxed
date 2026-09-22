import { describe, expect, it } from 'vitest';
import { EventBus } from '../src/core/events.js';

describe('EventBus', () => {
  it('delivers typed events to subscribers', () => {
    const bus = new EventBus<{ ping: { n: number } }>();
    const got: number[] = [];
    bus.on('ping', (e) => got.push(e.n));
    bus.emit('ping', { n: 1 });
    bus.emit('ping', { n: 2 });
    expect(got).toEqual([1, 2]);
  });

  it('unsubscribe stops delivery', () => {
    const bus = new EventBus<{ ping: { n: number } }>();
    const got: number[] = [];
    const off = bus.on('ping', (e) => got.push(e.n));
    bus.emit('ping', { n: 1 });
    off();
    bus.emit('ping', { n: 2 });
    expect(got).toEqual([1]);
  });

  it('subscriber errors do not break other subscribers', () => {
    const bus = new EventBus<{ ping: { n: number } }>();
    const got: number[] = [];
    bus.on('ping', () => { throw new Error('boom'); });
    bus.on('ping', (e) => got.push(e.n));
    bus.emit('ping', { n: 7 });
    expect(got).toEqual([7]);
  });
});
