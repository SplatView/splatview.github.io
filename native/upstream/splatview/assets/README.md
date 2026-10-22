The Opsiclear logo is the same asset used by COLMAPView:
https://github.com/ColmapView/Colmapview.github.io/blob/main/public/LOGO.png

It is embedded in the executable and Explorer handler for the requested Opsiclear branding.

The UI filters the original PNG to the physical logo size for each display scale, averaging premultiplied color and alpha before converting to ImGui's straight-alpha format. It caches that texture and draws it on whole pixels for smooth curves at small sizes.

`opsiclear.ico` packages the same logo at 16, 20, 24, 32, 40, 48, 64, 128 and 256 pixels for Windows application, taskbar and file icons.
