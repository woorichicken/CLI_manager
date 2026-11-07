# Phone document fixtures

Pages made by the kits' own scripts, so T102 tests what real reports contain. Regenerate them when a kit changes how
it copies or stores comments, and replace absolute paths with `/fixture/` (the build writes them into `storeKey`).

| File | Made by |
|---|---|
| `eli5.html` | a small page + `eli5/scripts/add-feedback.mjs` |
| `eli5b.html` | by hand: a second page beside it |
| `ba.html` | `before-after-review/scripts/build.mjs` (it adds `flow-verify-report`'s point-feedback widget) |
| `hfk/hfk.html`, `hfk/img/` | `html-feedback-kit/scripts/render.mjs --embed never` on the kit's example data |
| `a.png` | an 8×8 picture |
