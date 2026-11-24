# Image Forge

Cut the views out of a character or object sheet, in the browser.

**https://h0bb3.github.io/image-forge/**

Image generators often answer with one picture holding several views of the
same thing: front, side, back. Tools that build a 3D model from views want
them as separate pictures with no background. Image Forge does the cutting:

1. Drop, paste (Ctrl+V) or open a picture. The background is removed and the
   separate parts are found and boxed.
2. Say which part is which: with a part selected, press **F**ront, **B**ack,
   **L**eft, **R**ight, **T**op or **D** for bottom (or click the view). The
   next part without a view is selected for you, so a sheet of four is four
   key presses.
3. **Export zip** (Ctrl+S): `name_front.png`, `name_back.png` and so on.

Nothing is uploaded; the picture never leaves the page.

## Details

- **Background.** The colour is taken from the border of the picture, or
  picked (the colour field, or *Pick in picture*). *Tolerance* is how far
  from that colour still counts as background, *Soft edge* fades the
  boundary and takes the background's tint out of it, *Clean the edges*
  gives the smoothed pixels of an edge their transparency, so that no halo
  of the background follows the part, and *Shrink edge* cuts away what is
  still left of one. Only background reached from the border is removed, so a white
  eye survives in a white sheet; *Also inside the parts* removes enclosed
  gaps as well. A picture that is already cut out is left as it is.
- **Parts.** Drag in the picture to mark a part by hand, drag a box or its
  handles to adjust it, Delete removes it, Tab goes to the next. *Join
  pieces closer than* decides when loose pieces count as one part.
- **Several pictures.** Views can come from different pictures: open more
  than one and switch between them below the picture.
- **Export.** Each view is trimmed to its content, padded and centred. With
  *One size for all views* every picture gets the same size, so the views
  keep their scale to each other. *save* on a view downloads that one alone.
- **Keys.** Wheel zooms, Space or the middle button pans, 0 fits, O shows
  the original while held, arrows nudge the selected part.
- `?src=address` opens a picture from an address, if its site allows that.

The background removal goes by colour, which suits generated sheets on a
plain background. It does not cut a subject out of a photograph.

## Development

Plain HTML, CSS and JavaScript modules; no build step and no dependencies.
Serve the folder (`python -m http.server`) and open it. `test.html` runs the
tests of `core.js` in the browser. `tools/make_sample.py` draws `sample.png`.

MIT licence.
