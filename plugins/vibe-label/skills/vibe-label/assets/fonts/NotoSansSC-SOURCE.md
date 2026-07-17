# Noto Sans SC VibeLabel subset

`NotoSansSC-VibeLabel.woff2` is a variable-weight subset used for VibeLabel's
fixed Simplified Chinese interface copy. It is not intended to cover arbitrary
repository names, branch names, or other user-provided text.

## Upstream

- Project: Noto Sans SC in the official Google Fonts repository
- Revision: `389b770410cc0b7c21c85673bfa2077420fe7f65`
- Source: `ofl/notosanssc/NotoSansSC[wght].ttf`
- Source URL: <https://raw.githubusercontent.com/google/fonts/389b770410cc0b7c21c85673bfa2077420fe7f65/ofl/notosanssc/NotoSansSC%5Bwght%5D.ttf>
- Source SHA-256: `a3041811a78c361b1de50f953c805e0244951c21c5bd412f7232ef0d899af0da`
- Source size: 17,772,300 bytes
- License: SIL Open Font License 1.1; see `NotoSansSC-OFL.txt`

## Character set

`NotoSansSC-subset-chars.txt` is the sorted set of 208 non-ASCII Unicode
characters used by the fixed `zh-CN` copy in `scripts/lib/i18n.mjs`. It includes
the Chinese punctuation used by that copy. The file is the authoritative input
to the subset command.

## Generation

The checked-in font was generated with Python 3.13, FontTools 4.63.0, Brotli
1.2.0, and Zopfli 0.4.3. Run these commands from this `fonts` directory:

```sh
python3 -m venv /tmp/vibelabel-fonttools
/tmp/vibelabel-fonttools/bin/pip install 'fonttools[woff]==4.63.0'
curl -fL 'https://raw.githubusercontent.com/google/fonts/389b770410cc0b7c21c85673bfa2077420fe7f65/ofl/notosanssc/NotoSansSC%5Bwght%5D.ttf' -o /tmp/NotoSansSC-wght.ttf
/tmp/vibelabel-fonttools/bin/pyftsubset /tmp/NotoSansSC-wght.ttf \
  --text-file=NotoSansSC-subset-chars.txt \
  --flavor=woff2 \
  --no-recalc-timestamp \
  --output-file=NotoSansSC-VibeLabel.woff2
```

Output:

- Size: 58,776 bytes
- SHA-256: `9cb58acb78a5edf2bba119bd5e4a1b9af03de01c7a58020fc700e9672ab275c7`
- Weight axis: 100 through 900

## Verification

The WOFF2 cmap contains exactly the 208 characters in the character-set file.
Regeneration is deterministic with the pinned inputs and command above.
