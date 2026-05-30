---
title: "Cache eviction: when and who"
description: "How a byte budget creates the need for eviction, and why LRU is the right default policy for picking the victim."
---

# Cache eviction: when and who

Eviction combines two independent decisions worth separating: *should I evict?* and *who do I evict?* Conflating them is the most common source of confusion when reading cache code.

## The *why* — a byte budget — answers "*should* I evict?"

Memory is finite. On the $5 VPS Marengo's audience runs, you might have 1 GB total; the user sets `cache.max_size_mb: 512` in YAML and we promise never to exceed it. Without that cap:

- A busy blog (~50 KB pages × ~10 K unique URLs) → ~500 MB just from page content.
- An API serving lots of unique paths over time → unbounded growth → OOM → the kernel kills the process.

The budget is a **resource contract**: "give me N MB of RAM and I'll stay inside it."

## The *who* — LRU — answers "*which* entry do I drop?"

Once we've decided "I'm over budget; one must go," there are several reasonable choices, each with different hit-rate consequences:

| Policy    | What it drops                       | Trade-off                                                                |
| --------- | ----------------------------------- | ------------------------------------------------------------------------ |
| **FIFO**  | Whatever entered first              | Simple, but might toss a hot entry just because it's been there a while. |
| **Random**| A random entry                      | Surprisingly not terrible — but ignores all signal from your traffic.    |
| **LFU**   | The one accessed the fewest times   | Great for stable hot-sets; slow to adapt when traffic changes.           |
| **LRU**   | The one untouched the longest       | Good default — adapts to traffic, simple. *What we chose.*               |

LRU is the popular default because **recency is a strong predictor of nearness of next access**. If something hasn't been hit in a while, it's probably not about to be.

## How that splits in the code

- `if (size > this.maxBytes) return` and the `while (currentBytes > maxBytes)` loop in `set()` — **the budget enforcing itself** (the *why*).
- The touch in `get()` and dropping `entries.keys().next().value` in `evict()` — **LRU choosing the victim** (the *who*).

Swap the LRU touch for a random pick and you'd have a "random replacement" cache with the same byte budget: same outer logic, different selection inside.

## See also

- [LRU cache: the data structure](./lru-cache-data-structure.md) — *how* the LRU ordering is actually maintained.
