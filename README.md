# Image Forge

Cut the views out of a character or object sheet, in the browser.

**https://h0bb3.github.io/image-forge/**

Image generators often answer with one picture holding several views of the
same thing: front, side, back. Tools that build a 3D model from views want
them as separate pictures with no background. Image Forge does the cutting:

1. Drop, paste (Ctrl+V) or open a picture. The background is removed and the
   separate parts are found and boxed.
2. Say which part is which: with a part selected, press **F**ront, **B**ack,
   **L**eft, **R**ight, **T**op or **D** for bottom, or click the view in
   the bar that sits at the selected part (above it, or where you clicked it). The next part without a view
   is selected for you, so a sheet of four is four clicks or key presses.
3. **Export images** (Ctrl+S) downloads `name_front.png`, `name_back.png`
   and so on, one by one; **Zip** (Ctrl+Shift+S) puts them in one file. The
   first time, the browser asks whether the page may download several files.

Nothing is uploaded; the picture never leaves the page.

## Details

- **By AI model.** *Method* in the Background section chooses how the
  background is found. *By AI model* runs IS-Net in the browser: it finds
  the figures themselves, so closed-in gaps, shadows and backgrounds that
  are not plain go too. It takes about 15 seconds a picture and downloads
  the model (180 MB) the first time; the browser keeps it. *Both* takes the
  sharp cut by colour and removes what the model calls background as well.
  The choice is remembered, and the erasing by hand works on top of all three.
- **Background.** The colour is taken from the border of the picture, or
  picked (the colour field, or *Pick in picture*). *Tolerance* is how far
  from that colour still counts as background, *Soft edge* fades the
  boundary and takes the background's tint out of it, *Clean the edges*
  gives the smoothed pixels of an edge their transparency, so that no halo
  of the background follows the part, and *Shrink edge* cuts away what is
  still left of one. Only background reached from the border is removed, so a white
  eye survives in a white sheet; *Also inside the parts* removes enclosed
  gaps as well. A picture that is already cut out is left as it is.
- **A view from another view.** *from…* on a view takes it from another
  one instead of from a part of its own: one click makes left the mirrored
  right (or back the mirrored front, and so on), and the panel that opens
  lets you choose the source, mirroring and a turn of 90° or 180°. The
  choice is remembered for the next sheet.
- **Projects.** *Save project* writes one `.imageforge` file with the
  pictures, the parts and their views, what was erased by hand and all
  settings. Open or drop that file later to go on where you were. (It is a
  zip of `project.json`, the pictures and the masks.)
- **By hand.** The tools at the top left of the picture. *Erase area* (W):
  click an area that should have gone, such as the gap between two legs,
  and all of it that is one colour becomes transparent; click again where a
  shadow is left. *Eraser* (E) and *Restore* (Q) are brushes that paint
  transparency or the original picture; `[` and `]` change their size.
  Ctrl+Z undoes, V goes back to selecting.
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

The model is IS-Net, general use, by Xuebin Qin et al. ("Highly Accurate
Dichotomous Image Segmentation", Apache 2.0), in the ONNX conversion of
[rembg](https://github.com/danielgatis/rembg) as hosted by
[BritishWerewolf/IS-Net](https://huggingface.co/BritishWerewolf/IS-Net). It
runs on [ONNX Runtime Web](https://onnxruntime.ai). Both are loaded from
their own hosts when *By AI model* is first chosen; without that choice the
page loads nothing from elsewhere.

## Development

Plain HTML, CSS and JavaScript modules; no build step and no dependencies.
Serve the folder (`python -m http.server`) and open it. `test.html` runs the
tests of `core.js` in the browser. `tools/make_sample.py` draws `sample.png`.

MIT licence.
