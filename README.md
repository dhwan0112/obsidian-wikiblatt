# Wikiblatt

Wiki-style utilities for Obsidian. Works with any theme; pairs with the Wikibaum theme, which supplies the exact colors.

- **Sidebar cards**: most linked notes (ranked by how many other notes link to them) and recent changes with relative times ("27초 전", "3분 전").
- **Section rail**: a column of dots on the right edge of each note, placed by where each heading sits in the note. Hover to see numbered headings ("1.", "2.1."); click to jump.
- **Floating buttons**: a numbered contents panel, scroll to top, scroll to bottom.
- **File tags card** (with the [Wikiwurzel](https://github.com/dhwan0112/obsidian-wikiwurzel) plugin): shows and edits the tags of the file being viewed, PDFs and other attachments included, lists every tag and the files under it, and opens Wikiwurzel's tag search. Hidden when Wikiwurzel is not installed.
- **Reorder cards**: drag a card by its title to move it up or down; the order is kept.

Times and labels follow the app language (Korean or English).

## Settings

Excluded folders, number of items, numbering start (Auto / H1 / H2), minimum dot spacing, and switches for each part. "Auto" follows the Wikibaum theme's "Start numbering at H2" option.

## Build

```
npm install
npm run build
```

## 한국어 안내

나무위키식 사이드바(많이 참조된 문서, 최근 변경), 문단 점 레일(호버 시 번호 목차), 목차 팝업·맨 위·맨 아래 버튼을 추가합니다. Wikiwurzel 플러그인을 함께 쓰면 사이드바에 파일 태그 카드(PDF 포함)가 생기고, 카드는 제목을 끌어 순서를 바꿀 수 있습니다. 나무위키와 무관한 비공식 플러그인입니다.

## License

MIT
