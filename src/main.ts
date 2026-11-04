import {
	App,
	HeadingCache,
	ItemView,
	Keymap,
	MarkdownView,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
	WorkspaceLeaf,
	debounce,
	moment,
	setIcon,
} from "obsidian";

const VIEW_TYPE = "arbor-wiki-sidebar";
const TIME_TICK_MS = 5_000;

type NumberingStart = "auto" | "1" | "2";
type LabelLanguage = "auto" | "ko" | "en";

interface WikiSettings {
	// Sidebar cards
	showRecent: boolean;
	showPopular: boolean;
	recentCount: number;
	popularCount: number;
	excludedFolders: string;
	openOnStartup: boolean;
	fitToHeight: boolean;
	language: LabelLanguage;
	// Editor utilities
	showRail: boolean;
	showButtons: boolean;
	showEditLinks: boolean;
	railMinGap: number;
	numberingStart: NumberingStart;
}

const DEFAULT_SETTINGS: WikiSettings = {
	showRecent: true,
	showPopular: true,
	recentCount: 10,
	popularCount: 10,
	excludedFolders: "",
	openOnStartup: true,
	fitToHeight: true,
	language: "auto",
	showRail: true,
	showButtons: true,
	showEditLinks: true,
	railMinGap: 30,
	numberingStart: "auto",
};

/* ---------- Text ---------- */

let labelLanguage: LabelLanguage = "auto";
const isKorean = () =>
	labelLanguage === "ko" || (labelLanguage === "auto" && moment.locale().startsWith("ko"));

const T = {
	recent: () => (isKorean() ? "최근 변경" : "Recent changes"),
	popular: () => (isKorean() ? "많이 참조된 문서" : "Most linked"),
	empty: () => (isKorean() ? "표시할 항목이 없습니다." : "Nothing to show."),
	viewTitle: () => (isKorean() ? "위키 사이드바" : "Wiki sidebar"),
	refCount: (n: number) => (isKorean() ? `${n}회` : `${n}`),
	toc: () => (isKorean() ? "목차" : "Contents"),
	top: () => (isKorean() ? "맨 위로" : "Scroll to top"),
	bottom: () => (isKorean() ? "맨 아래로" : "Scroll to bottom"),
	edit: () => (isKorean() ? "[편집]" : "[edit]"),
};

/** Wiki-style relative time: "방금 전", "27초 전", "3분 전", "2시간 전", "5일 전". */
export function relativeTime(then: number, now: number): string {
	const sec = Math.max(0, Math.floor((now - then) / 1000));
	const ko = isKorean();
	if (sec < 5) return ko ? "방금 전" : "just now";
	if (sec < 60) return ko ? `${sec}초 전` : `${sec}s ago`;
	const min = Math.floor(sec / 60);
	if (min < 60) return ko ? `${min}분 전` : `${min}m ago`;
	const hr = Math.floor(min / 60);
	if (hr < 24) return ko ? `${hr}시간 전` : `${hr}h ago`;
	const day = Math.floor(hr / 24);
	if (day < 30) return ko ? `${day}일 전` : `${day}d ago`;
	if (day < 365) {
		const mon = Math.floor(day / 30);
		return ko ? `${mon}개월 전` : `${mon}mo ago`;
	}
	const yr = Math.floor(day / 365);
	return ko ? `${yr}년 전` : `${yr}y ago`;
}

/* ---------- Section numbering (shared by the rail) ---------- */

interface NumberedHeading {
	label: string; // "2.1."
	text: string;
	line: number;
	depth: number; // 0 = top level
}

/**
 * Number headings the way the Wikibaum theme does.
 * "auto" follows the theme's "Start numbering at H2" switch when it is on,
 * otherwise starts at H1 if the note has one, else at its highest heading level.
 */
export function numberHeadings(
	headings: HeadingCache[],
	start: NumberingStart,
	themeStartsAtH2: boolean,
): NumberedHeading[] {
	if (headings.length === 0) return [];
	let base: number;
	if (start === "1") base = 1;
	else if (start === "2") base = 2;
	else if (themeStartsAtH2) base = 2;
	else base = Math.min(...headings.map((h) => h.level));

	const counters = [0, 0, 0, 0, 0, 0];
	const out: NumberedHeading[] = [];
	for (const h of headings) {
		if (h.level < base) continue;
		const d = h.level - base;
		counters[d]++;
		for (let i = d + 1; i < counters.length; i++) counters[i] = 0;
		out.push({
			label: counters.slice(0, d + 1).join(".") + ".",
			text: h.heading,
			line: h.position.start.line,
			depth: d,
		});
	}
	return out;
}

/**
 * Place dots proportionally to where each heading sits in the note,
 * keeping at least `gap` px between neighbours and staying inside [0, height].
 */
export function layoutDots(fractions: number[], height: number, gap: number): number[] {
	const n = fractions.length;
	if (n === 0) return [];
	if ((n - 1) * gap >= height) return fractions.map((_, i) => (i * height) / Math.max(1, n - 1));
	const y = fractions.map((f) => f * height);
	for (let i = 1; i < n; i++) y[i] = Math.max(y[i], y[i - 1] + gap);
	if (y[n - 1] > height) {
		y[n - 1] = height;
		for (let i = n - 2; i >= 0; i--) y[i] = Math.min(y[i], y[i + 1] - gap);
	}
	return y;
}

/* ---------- Sidebar view ---------- */

const MIN_VISIBLE_ITEMS = 3;

class WikiSidebarView extends ItemView {
	private resizeObserver: ResizeObserver | null = null;

	constructor(leaf: WorkspaceLeaf, private plugin: ArborWiki) {
		super(leaf);
	}

	getViewType() {
		return VIEW_TYPE;
	}
	getDisplayText() {
		return T.viewTitle();
	}
	getIcon() {
		return "panel-right";
	}

	async onOpen() {
		this.render();
		this.resizeObserver = new ResizeObserver(() => this.fit());
		this.resizeObserver.observe(this.contentEl);
	}

	async onClose() {
		this.resizeObserver?.disconnect();
		this.resizeObserver = null;
	}

	render() {
		const root = this.contentEl;
		root.empty();
		root.addClass("aw-sidebar");
		const s = this.plugin.settings;
		if (s.showPopular) this.renderPopular(root);
		if (s.showRecent) this.renderRecent(root);
		this.fit();
	}

	/**
	 * Show as many rows as the pane can hold. The item counts in settings are maximums;
	 * rows are hidden from the bottom of the longer list first, down to MIN_VISIBLE_ITEMS each.
	 */
	fit() {
		const root = this.contentEl;
		const lists = Array.from(root.querySelectorAll<HTMLElement>(".aw-card-list"));
		const rows = lists.map((l) => Array.from(l.querySelectorAll<HTMLElement>(".aw-card-item")));
		rows.flat().forEach((r) => r.show());
		if (!this.plugin.settings.fitToHeight || root.clientHeight === 0) return;

		const visible = rows.map((r) => r.length);
		while (root.scrollHeight > root.clientHeight) {
			let target = -1;
			for (let i = 0; i < rows.length; i++) {
				if (visible[i] <= MIN_VISIBLE_ITEMS) continue;
				if (target === -1 || visible[i] > visible[target]) target = i;
			}
			if (target === -1) break;
			visible[target]--;
			rows[target][visible[target]].hide();
		}
	}

	/** Update only the "N초 전" labels so hovering and clicking are not interrupted. */
	tickTimes() {
		const now = Date.now();
		this.contentEl.querySelectorAll<HTMLElement>(".aw-card-time").forEach((el) => {
			const t = Number(el.dataset.mtime);
			if (t) el.setText(relativeTime(t, now));
		});
	}

	private card(parent: HTMLElement, icon: string, title: string, progress = false) {
		const card = parent.createDiv({ cls: "aw-card" });
		if (progress) card.createDiv({ cls: "aw-card-progress" });
		const header = card.createDiv({ cls: "aw-card-header" });
		setIcon(header.createSpan({ cls: "aw-card-icon" }), icon);
		header.createSpan({ cls: "aw-card-title", text: title });
		return card.createEl("ul", { cls: "aw-card-list" });
	}

	private link(parent: HTMLElement, file: TFile) {
		const a = parent.createEl("a", {
			cls: "aw-card-link",
			text: file.basename,
			attr: { href: file.path },
		});
		a.addEventListener("click", (evt) => {
			evt.preventDefault();
			this.app.workspace.openLinkText(file.path, "", Keymap.isModEvent(evt));
		});
		a.addEventListener("mouseover", (evt) => {
			this.app.workspace.trigger("hover-link", {
				event: evt,
				source: VIEW_TYPE,
				hoverParent: this,
				targetEl: a,
				linktext: file.path,
			});
		});
		return a;
	}

	private renderRecent(root: HTMLElement) {
		const list = this.card(root, "history", T.recent(), true);
		const files = this.plugin.recentFiles();
		if (files.length === 0) {
			list.createEl("li", { cls: "aw-card-empty", text: T.empty() });
			return;
		}
		const now = Date.now();
		for (const f of files) {
			const li = list.createEl("li", { cls: "aw-card-item" });
			this.link(li, f);
			const time = li.createSpan({ cls: "aw-card-meta aw-card-time" });
			time.dataset.mtime = String(f.stat.mtime);
			time.setText(relativeTime(f.stat.mtime, now));
		}
	}

	private renderPopular(root: HTMLElement) {
		const list = this.card(root, "building-2", T.popular());
		list.addClass("is-ranked");
		const ranked = this.plugin.popularFiles();
		if (ranked.length === 0) {
			list.createEl("li", { cls: "aw-card-empty", text: T.empty() });
			return;
		}
		ranked.forEach(({ file, count }, i) => {
			const li = list.createEl("li", { cls: "aw-card-item" });
			li.createSpan({ cls: "aw-card-rank", text: String(i + 1) });
			this.link(li, file);
			li.createSpan({ cls: "aw-card-meta", text: T.refCount(count) });
		});
	}
}

/* ---------- Editor utilities: section rail + floating buttons ---------- */

class EditorUtilities {
	private root: HTMLElement;
	private rail: HTMLElement;
	private buttons: HTMLElement;
	private tocWrap!: HTMLElement;
	private tocButton!: HTMLButtonElement;
	private tocPanel!: HTMLElement;
	private resizeObserver: ResizeObserver;

	constructor(private plugin: ArborWiki, private view: MarkdownView) {
		this.root = view.contentEl.createDiv({ cls: "aw-utilities" });
		this.rail = this.root.createDiv({ cls: "aw-rail" });
		this.buttons = this.root.createDiv({ cls: "aw-float-buttons" });
		this.buildButtons();
		this.resizeObserver = new ResizeObserver(() => {
			this.renderRail();
			this.renderToc();
		});
		this.resizeObserver.observe(this.rail);
		this.update();
	}

	private buildButtons() {
		this.tocWrap = this.buttons.createDiv({ cls: "aw-toc-wrap" });
		this.tocButton = this.tocWrap.createEl("button", {
			cls: "aw-float-button aw-float-toc",
			attr: { "aria-label": T.toc(), "aria-expanded": "false" },
		});
		setIcon(this.tocButton, "list");
		this.tocButton.addEventListener("click", () => this.toggleToc());
		this.tocPanel = this.tocWrap.createDiv({ cls: "aw-toc-panel", attr: { role: "dialog", "aria-label": T.toc() } });
		this.tocPanel.hide();

		const group = this.buttons.createDiv({ cls: "aw-float-group" });
		const up = group.createEl("button", { cls: "aw-float-button", attr: { "aria-label": T.top() } });
		setIcon(up, "arrow-up");
		up.addEventListener("click", () => this.scrollTo("top"));
		const down = group.createEl("button", { cls: "aw-float-button", attr: { "aria-label": T.bottom() } });
		setIcon(down, "arrow-down");
		down.addEventListener("click", () => this.scrollTo("bottom"));
	}

	isTocOpen() {
		return this.tocPanel.isShown();
	}

	/** True when the event happened inside this note's contents button or panel. */
	containsTarget(target: EventTarget | null) {
		return target instanceof Node && this.tocWrap.contains(target);
	}

	toggleToc(force?: boolean) {
		const open = force ?? !this.isTocOpen();
		this.tocPanel.toggle(open);
		this.tocButton.toggleClass("is-active", open);
		this.tocButton.setAttr("aria-expanded", String(open));
		if (open) this.renderToc();
	}

	private headings(): NumberedHeading[] {
		const file = this.view.file;
		if (!file) return [];
		const cache = this.plugin.app.metadataCache.getFileCache(file);
		return numberHeadings(
			cache?.headings ?? [],
			this.plugin.settings.numberingStart,
			document.body.classList.contains("aw-numbers-from-h2"),
		);
	}

	private jump(line: number) {
		this.view.setEphemeralState({ line });
	}

	renderToc() {
		if (!this.isTocOpen()) return;
		const panel = this.tocPanel;
		panel.empty();

		// Fit the panel between the top of the note and the bottom of the button.
		const top = this.view.contentEl.getBoundingClientRect().top;
		const bottom = this.tocButton.getBoundingClientRect().bottom;
		const left = this.view.contentEl.getBoundingClientRect().left;
		const right = this.tocButton.getBoundingClientRect().left - 22;
		panel.setCssProps({
			"--aw-toc-max-height": `${Math.max(120, bottom - top - 16)}px`,
			"--aw-toc-max-width": `${Math.max(180, right - left - 16)}px`,
		});

		panel.createDiv({ cls: "aw-toc-title", text: T.toc() });
		const items = this.headings();
		if (items.length === 0) {
			panel.createDiv({ cls: "aw-toc-empty", text: T.empty() });
			return;
		}
		const list = panel.createDiv({ cls: "aw-toc-list" });
		for (const it of items) {
			const row = list.createDiv({ cls: "aw-toc-item" });
			row.setCssProps({ "--aw-toc-depth": String(it.depth) });
			row.createSpan({ cls: "aw-toc-number", text: it.label });
			row.createSpan({ cls: "aw-toc-text", text: " " + it.text });
			row.addEventListener("click", () => this.jump(it.line));
		}
	}

	private scrollTo(where: "top" | "bottom") {
		const el =
			this.view.getMode() === "preview"
				? this.view.previewMode.containerEl.querySelector<HTMLElement>(".markdown-preview-view") ??
				  this.view.previewMode.containerEl
				: this.view.contentEl.querySelector<HTMLElement>(".cm-scroller");
		if (!el) return;
		el.scrollTo({ top: where === "top" ? 0 : el.scrollHeight, behavior: "smooth" });
	}

	update() {
		const s = this.plugin.settings;
		this.rail.toggle(s.showRail);
		this.buttons.toggle(s.showButtons);
		this.root.toggleClass("has-buttons", s.showButtons);
		this.renderRail();
	}

	renderRail() {
		const s = this.plugin.settings;
		this.rail.empty();
		const file = this.view.file;
		if (!s.showRail || !file) return;
		const cache = this.plugin.app.metadataCache.getFileCache(file);
		const items = this.headings();
		if (items.length === 0) return;

		const lastLine = Math.max(
			1,
			cache?.sections?.at(-1)?.position.end.line ?? items[items.length - 1].line,
		);
		const height = this.rail.clientHeight;
		if (height <= 0) return;
		const ys = layoutDots(
			items.map((it) => it.line / lastLine),
			height,
			s.railMinGap,
		);

		// Many headings in a short pane: use smaller labels so they do not overlap.
		const minStep = ys.slice(1).reduce((m, y, i) => Math.min(m, y - ys[i]), Infinity);
		this.rail.toggleClass("is-dense", minStep < 28);

		items.forEach((it, i) => {
			const row = this.rail.createDiv({ cls: "aw-rail-item" + (it.depth === 0 ? " is-major" : "") });
			row.setCssProps({ "--aw-rail-y": `${ys[i]}px` });
			row.createSpan({ cls: "aw-rail-label", text: `${it.label} ${it.text}` });
			row.createSpan({ cls: "aw-rail-dot" });
			row.addEventListener("click", () => this.jump(it.line));
		});
	}

	destroy() {
		this.resizeObserver.disconnect();
		this.root.remove();
	}
}

/* ---------- Plugin ---------- */

export default class ArborWiki extends Plugin {
	settings: WikiSettings = DEFAULT_SETTINGS;
	private utilities = new Map<MarkdownView, EditorUtilities>();

	private refreshSidebar = debounce(() => this.renderSidebars(), 500, true);
	private refreshEditors = debounce(() => this.syncEditors(), 200, true);

	async onload() {
		await this.loadSettings();

		this.registerView(VIEW_TYPE, (leaf) => new WikiSidebarView(leaf, this));
		this.registerHoverLinkSource(VIEW_TYPE, { display: "Wikiblatt sidebar", defaultMod: true });

		this.addCommand({
			id: "open-sidebar",
			name: "Open wiki sidebar",
			callback: () => this.activateView(true),
		});

		// Sidebar data
		this.registerEvent(this.app.vault.on("modify", () => this.refreshSidebar()));
		this.registerEvent(this.app.vault.on("create", () => this.refreshSidebar()));
		this.registerEvent(this.app.vault.on("delete", () => this.refreshSidebar()));
		this.registerEvent(this.app.vault.on("rename", () => this.refreshSidebar()));
		this.registerEvent(this.app.metadataCache.on("resolved", () => this.refreshSidebar()));
		this.registerInterval(window.setInterval(() => this.tickSidebars(), TIME_TICK_MS));

		// Editor utilities
		this.registerEvent(this.app.workspace.on("layout-change", () => this.refreshEditors()));
		this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.refreshEditors()));
		this.registerEvent(this.app.workspace.on("file-open", () => this.refreshEditors()));
		this.registerEvent(
			this.app.metadataCache.on("changed", (file) => {
				for (const [view, u] of this.utilities) {
					if (view.file !== file) continue;
					u.renderRail();
					u.renderToc();
				}
			}),
		);
		// Theme switches (Style Settings toggles body classes) change the numbering base.
		const bodyObserver = new MutationObserver(() => this.utilities.forEach((u) => u.renderRail()));
		bodyObserver.observe(document.body, { attributes: true, attributeFilter: ["class"] });
		this.register(() => bodyObserver.disconnect());

		// "[편집]" links on headings in Reading view.
		this.registerMarkdownPostProcessor((el, ctx) => {
			if (!this.settings.showEditLinks) return;
			const heading = el.querySelector<HTMLElement>("h1, h2, h3, h4, h5, h6");
			if (!heading) return;
			const info = ctx.getSectionInfo(el);
			if (!info) return;
			heading.addClass("aw-has-edit-link");
			const link = heading.createSpan({ cls: "aw-edit-link", text: T.edit() });
			link.addEventListener("click", (evt) => {
				evt.preventDefault();
				evt.stopPropagation();
				this.editAt(link, info.lineStart);
			});
		});

		// Close open contents panels on a click elsewhere or on Escape.
		this.registerDomEvent(document, "pointerdown", (evt) => {
			this.utilities.forEach((u) => {
				if (u.isTocOpen() && !u.containsTarget(evt.target)) u.toggleToc(false);
			});
		});
		this.registerDomEvent(document, "keydown", (evt) => {
			if (evt.key === "Escape") this.utilities.forEach((u) => u.isTocOpen() && u.toggleToc(false));
		});

		this.addSettingTab(new WikiSettingTab(this.app, this));

		this.app.workspace.onLayoutReady(() => {
			this.syncEditors();
			// When the plugin is re-enabled or updated, Obsidian restores the old
			// sidebar leaf only after onload finishes. Checking right away would
			// miss it and add a second sidebar, so wait one task.
			if (this.settings.openOnStartup) window.setTimeout(() => void this.activateView(false), 0);
		});
	}

	onunload() {
		this.utilities.forEach((u) => u.destroy());
		this.utilities.clear();
	}

	/** Attach utilities to every open Markdown view and drop those that closed. */
	syncEditors() {
		const live = new Set<MarkdownView>();
		for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
			const view = leaf.view;
			if (!(view instanceof MarkdownView)) continue;
			live.add(view);
			const u = this.utilities.get(view);
			if (u) u.renderRail();
			else this.utilities.set(view, new EditorUtilities(this, view));
		}
		for (const [view, u] of this.utilities) {
			if (!live.has(view)) {
				u.destroy();
				this.utilities.delete(view);
			}
		}
	}

	/** Switch the note that contains `el` to editing mode and put the cursor on `line`. */
	private async editAt(el: HTMLElement, line: number) {
		const leaf = this.app.workspace
			.getLeavesOfType("markdown")
			.find((l) => l.view instanceof MarkdownView && l.view.containerEl.contains(el));
		if (!leaf || !(leaf.view instanceof MarkdownView)) return;
		const state = leaf.getViewState();
		await leaf.setViewState({ ...state, state: { ...state.state, mode: "source" } });
		const view = leaf.view;
		view.editor.setCursor({ line, ch: 0 });
		view.setEphemeralState({ line });
		view.editor.focus();
	}

	async activateView(reveal: boolean) {
		const { workspace } = this.app;
		let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
		if (!leaf) {
			const right = workspace.getRightLeaf(false);
			if (!right) return;
			await right.setViewState({ type: VIEW_TYPE, active: false });
			leaf = right;
		}
		if (reveal) await workspace.revealLeaf(leaf);
	}

	private sidebarViews(): WikiSidebarView[] {
		return this.app.workspace
			.getLeavesOfType(VIEW_TYPE)
			.map((l) => l.view)
			.filter((v): v is WikiSidebarView => v instanceof WikiSidebarView);
	}

	renderSidebars() {
		this.sidebarViews().forEach((v) => v.render());
	}

	private tickSidebars() {
		this.sidebarViews().forEach((v) => v.tickTimes());
	}

	private excluded(): string[] {
		return this.settings.excludedFolders
			.split(",")
			.map((s) => s.trim().replace(/^\/+|\/+$/g, ""))
			.filter((s) => s.length > 0);
	}

	private isIncluded(path: string, excluded: string[]): boolean {
		return !excluded.some((dir) => path === dir || path.startsWith(dir + "/"));
	}

	recentFiles(): TFile[] {
		const ex = this.excluded();
		return this.app.vault
			.getMarkdownFiles()
			.filter((f) => this.isIncluded(f.path, ex))
			.sort((a, b) => b.stat.mtime - a.stat.mtime)
			.slice(0, this.settings.recentCount);
	}

	/** Rank notes by the number of distinct other notes that link to them. */
	popularFiles(): { file: TFile; count: number }[] {
		const ex = this.excluded();
		const counts = new Map<string, number>();
		const resolved = this.app.metadataCache.resolvedLinks;
		for (const source in resolved) {
			if (!this.isIncluded(source, ex)) continue;
			for (const target in resolved[source]) {
				if (target === source) continue;
				counts.set(target, (counts.get(target) ?? 0) + 1);
			}
		}
		const out: { file: TFile; count: number }[] = [];
		for (const [path, count] of counts) {
			if (!this.isIncluded(path, ex)) continue;
			const f = this.app.vault.getAbstractFileByPath(path);
			if (f instanceof TFile && f.extension === "md") out.push({ file: f, count });
		}
		return out
			.sort((a, b) => b.count - a.count || a.file.basename.localeCompare(b.file.basename))
			.slice(0, this.settings.popularCount);
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
		labelLanguage = this.settings.language;
	}

	async saveSettings() {
		labelLanguage = this.settings.language;
		await this.saveData(this.settings);
		this.renderSidebars();
		this.utilities.forEach((u) => u.update());
	}
}

/* ---------- Settings ---------- */

class WikiSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: ArborWiki) {
		super(app, plugin);
	}

	display() {
		const { containerEl } = this;
		containerEl.empty();
		const s = this.plugin.settings;
		const save = () => this.plugin.saveSettings();

		new Setting(containerEl)
			.setName("Label language")
			.setDesc("Language for card titles, times and buttons. Auto follows the app language.")
			.addDropdown((d) =>
				d
					.addOptions({ auto: "Auto", ko: "한국어", en: "English" })
					.setValue(s.language)
					.onChange(async (v) => {
						s.language = v as LabelLanguage;
						await save();
					}),
			);

		new Setting(containerEl).setName("Sidebar").setHeading();

		new Setting(containerEl)
			.setName("Excluded folders")
			.setDesc("Comma-separated folder paths to leave out, e.g. Templates, Attachments")
			.addText((t) =>
				t.setValue(s.excludedFolders).onChange(async (v) => {
					s.excludedFolders = v;
					await save();
				}),
			);

		new Setting(containerEl).setName("Show most linked notes").addToggle((t) =>
			t.setValue(s.showPopular).onChange(async (v) => {
				s.showPopular = v;
				await save();
			}),
		);
		new Setting(containerEl).setName("Number of most linked notes").addSlider((sl) =>
			sl.setLimits(3, 30, 1).setValue(s.popularCount).setDynamicTooltip().onChange(async (v) => {
				s.popularCount = v;
				await save();
			}),
		);
		new Setting(containerEl).setName("Show recent changes").addToggle((t) =>
			t.setValue(s.showRecent).onChange(async (v) => {
				s.showRecent = v;
				await save();
			}),
		);
		new Setting(containerEl).setName("Number of recent changes").addSlider((sl) =>
			sl.setLimits(3, 30, 1).setValue(s.recentCount).setDynamicTooltip().onChange(async (v) => {
				s.recentCount = v;
				await save();
			}),
		);
		new Setting(containerEl)
			.setName("Fit lists to panel height")
			.setDesc("Show only as many rows as fit; the numbers above become maximums.")
			.addToggle((t) =>
				t.setValue(s.fitToHeight).onChange(async (v) => {
					s.fitToHeight = v;
					await save();
				}),
			);
		new Setting(containerEl)
			.setName("Open on startup")
			.setDesc("Add the sidebar to the right side when Obsidian starts, if it is not already open.")
			.addToggle((t) =>
				t.setValue(s.openOnStartup).onChange(async (v) => {
					s.openOnStartup = v;
					await save();
				}),
			);

		new Setting(containerEl).setName("Editor").setHeading();

		new Setting(containerEl)
			.setName("Section rail")
			.setDesc("Dots on the right edge of each note. Hover to see numbered headings; click to jump.")
			.addToggle((t) =>
				t.setValue(s.showRail).onChange(async (v) => {
					s.showRail = v;
					await save();
				}),
			);
		new Setting(containerEl)
			.setName("Numbering starts at")
			.setDesc("Auto follows the Wikibaum theme's \"Start numbering at H2\" switch.")
			.addDropdown((d) =>
				d
					.addOptions({ auto: "Auto", "1": "H1", "2": "H2" })
					.setValue(s.numberingStart)
					.onChange(async (v) => {
						s.numberingStart = v as NumberingStart;
						await save();
					}),
			);
		new Setting(containerEl)
			.setName("Minimum dot spacing")
			.setDesc("Pixels between neighbouring dots.")
			.addSlider((sl) =>
				sl.setLimits(20, 40, 1).setValue(s.railMinGap).setDynamicTooltip().onChange(async (v) => {
					s.railMinGap = v;
					await save();
				}),
			);
		new Setting(containerEl)
			.setName("Edit links on headings")
			.setDesc("Show [편집] at the right end of each heading in Reading view. Reopen notes to apply.")
			.addToggle((t) =>
				t.setValue(s.showEditLinks).onChange(async (v) => {
					s.showEditLinks = v;
					await save();
				}),
			);
		new Setting(containerEl)
			.setName("Floating buttons")
			.setDesc("Contents, scroll to top, scroll to bottom.")
			.addToggle((t) =>
				t.setValue(s.showButtons).onChange(async (v) => {
					s.showButtons = v;
					await save();
				}),
			);
	}
}
