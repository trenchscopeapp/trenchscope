# Image codec fixtures (task-1326)

Tiny 32×32 "quadrant" test images (red / green / blue / white quarters) for `test/images-1326.test.ts`.
Generated once from a hand-built PPM with libjpeg-turbo 3.2 (`cjpeg`, `djpeg`) and ffmpeg, checked in so
the tests are self-contained:

| file | how |
|---|---|
| `quad-420.jpg` | `cjpeg -quality 92 -sample 2x2` (baseline, 4:2:0) |
| `quad-422.jpg` | `cjpeg -quality 92 -sample 2x1` (baseline, 4:2:2) |
| `quad-prog-rst.jpg` | `cjpeg -quality 92 -progressive -restart 1B -sample 1x1` (progressive + restart markers) |
| `quad-gray.jpg` | `cjpeg -quality 92 -grayscale` |
| `quad-arith.jpg` | `cjpeg -quality 92 -arithmetic` (must be REFUSED) |
| `*.ref.png` | `djpeg -pnm` of the matching JPEG (libjpeg's own decode), converted to PNG by ffmpeg — the reference pixels |
| `quad.gif` | `ffmpeg -pix_fmt pal8` of `quad-420.ref.png` |
