# paperclip-codegraph v0.9.11

The Map view is now the architecture map CodeGraph actually has, and the host's
Back button is gone.

## The Map was wrong, and I could look

The previous release offered a "Map" tab that drew the selected symbol's
callers and callees. That is not what CodeGraph's map is. Loading
`http://127.0.0.1:4747/#/map` and reading its DOM showed a different thing
entirely — an **architecture map**:

> each module sits one layer above the modules it depends on, so reading top to
> bottom follows the dependency direction. Line weight is how many calls, imports
> and type references cross the link.

That is worth having, so the tab now does that:

- **modules** with their file and symbol counts, and a bar showing how much leans
  on them, scaled against the most depended-on box;
- **links** weighted by reference count, thicker for more;
- **cycles reported in words**, because a layered drawing cannot express one. The
  edge that closes a cycle is drawn dashed and excluded from the layering rather
  than hidden, so the picture does not claim a hierarchy it does not have.
- **weak links held back** until a module they touch is selected, with the count
  stated. Hidden half a cycle would be a lie, so links touching a cycle are never
  held back.
- **controls that matter**: `Showing` scopes to a subtree with real file counts,
  `Grouping` picks the depth (automatic, or 1–4 folders), and `Include test
  modules` un-hides the test-only boxes.

Against the real POS index it produces **48 modules, 137 links, 17 layers, 2
cycles** from 5,415 cross-file edges — comparable to the viewer's 54/108/6 on the
same repository, which is the check that matters: not identical, but the same kind
of picture.

Three things the original does that this does not pretend to: hover-a-link to see
the symbol pairs behind the weight, copy-image, and download-SVG. The exclusions
note is there without the confidence threshold, because this plugin has no
confidence scores to threshold.

## The Back button is the host's, and a slot removes it

`PluginPage.tsx:166` renders `{!routeSidebarActive && <Back to dashboard>}`, and
`routeSidebarActive` is true only when `resolveRouteSidebarSlot` finds a
`routeSidebar` slot whose `routePath` matches the page slot's, in the same plugin.
No amount of page-side styling changes that: the answer is to declare one.

So the manifest now declares a `routeSidebar` beside the page, and it is used for
something real rather than to satisfy the check — **the view rail**. That is also
where the viewer keeps its views, so the page loses its tab bar and gains a proper
rail, with the view held in the URL (`#symbol`, `#map`) so the rail can link to it,
a reload keeps it, and the two cannot disagree.

The manifest test gained the capability mapping for the new slot type *and* an
assertion that the route sidebar's `routePath` still matches the page's — because
losing that pairing silently brings the Back button back, and nothing else would
notice.

## Testing

486 tests, 469 passing and 17 skipped without an index. New: 39 for the
architecture layout and map derivation, plus 7 that run against the real POS
index — including that no two modules overlap in a layer and that every drawn link
references a real module.

## Upgrading

```
paperclipai plugin install paperclip-codegraph@0.9.11
```

The manifest changed (a new slot), so Paperclip must reload the plugin.
