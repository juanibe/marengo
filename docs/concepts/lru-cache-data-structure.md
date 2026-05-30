---
title: "LRU cache: the data structure"
description: "Why an LRU cache isn't a queue and isn't just a hash map — it's both at once, and why a JS Map gives you the implementation for free."
---

# LRU cache: the data structure

`src/cache/store.ts` is short — under 200 lines. Most of what makes it a *cache* is the choice of data structure underneath. This note pins that choice down.

## It looks like a queue, but isn't

A pure queue is FIFO with no random access — push at the back, pop from the front, and the middle is invisible. That isn't enough here for two reasons:

- We look up entries by request key (random access).
- On a cache hit, we **move that entry to the back** so it doesn't get evicted next. A queue can't reorder a middle element.

## What it actually is: a hash map with a linked-list overlay

One shape that gives us both halves at once:

| Operation     | Hash-map half        | Linked-list half                       |
| ------------- | -------------------- | -------------------------------------- |
| `get` by key  | O(1) lookup          | + *touch*: move that node to the back  |
| `set`         | O(1) insert          | append at the back                     |
| eviction      | (drops the key too)  | pop from the front                     |

This pattern has names you'll recognise:

- **Java:** `LinkedHashMap`
- **Python:** `collections.OrderedDict` (its `.move_to_end()` is literally our "touch")
- Generic term: an **LRU cache**

## Why `store.ts` is so short

A JS `Map` already *is* this structure under the hood. It's a hash table plus an internal doubly-linked list that preserves and reports insertion order. `delete(k) + set(k, v)` is the "unlink and append to the back" operation we'd otherwise have to write ourselves.

```text
queue:        [A → B → C]      pop from front, push to back; nothing else.
                               no key lookup, cannot reorder.

MemoryStore:  [A | B | C]      ← evict-from-front (LRU)
               ↑   ↑   ↑       ← O(1) lookup by key (map-like)
              get(B) ⇒ [A | C | B]   ← reorder a middle node (queues can't)
```

The "RU" in LRU — *Recently Used* — is the part queues can't represent: recency changes with every read, and the structure has to reflect that. The touch is what turns "a queue-ish ordered map" into a real LRU cache.

## See also

- [Cache eviction: when and who](./cache-eviction.md) — what we do with this LRU ordering.
