# paperclip-codegraph v0.12.2

The switch now matches Paperclip's own, to the pixel.

## What was wrong

Two details, both invisible in a diff and obvious on screen beside the host's rows.

The **thumb was a square** — `16×16`. The host's is `h-4 w-6`: **24 wide by 16 tall**,
an oval. A square thumb in a capsule track reads as slightly off without it being
clear why.

The **track's 2px border was doing double duty**. The host's track is `h-5` (20px)
*including* a `border-2`, so its inner box is 16px — exactly the thumb's height, which
is what makes the thumb sit flush. Mine got there by accident rather than by the same
arithmetic.

The off state also ran `bg-input` at full strength where the host uses `bg-input/90` —
90% opacity, a slightly softer grey.

## Matched to the markup

Transcribed from a real settings page rather than from the component source alone:

```
track: relative inline-flex shrink-0 items-center rounded-full border-2
       transition-all h-5 w-11 border-transparent bg-input/90
thumb: pointer-events-none inline-block rounded-full bg-background shadow-sm
       transition-transform h-4 w-6 translate-x-0
```

- `data-slot="toggle"`, so anything the host targets by that attribute finds this one;
- `role="switch"` with `aria-checked`, unchanged — it was already a switch, not a
  checkbox.

## The travel is derived, not written down

The thumb's travel is `44 − 2×2 − 24 = 16`. That arithmetic is now in the code as
arithmetic:

```ts
const THUMB_TRAVEL = TRACK_WIDTH - TRACK_BORDER * 2 - THUMB_WIDTH;
```

A literal `16` would silently desync the moment any of those three changed — which is
exactly the class of mistake this release is fixing.

## Testing

484 tests, 479 passing and 5 skipped. Four new ones pin the geometry as numbers, since
that is what it is: the track and thumb sizes, the 2px border, that the travel is
derived rather than hardcoded, and that the host's arithmetic still comes out at 16.
