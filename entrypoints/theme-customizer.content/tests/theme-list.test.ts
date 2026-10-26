import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { parseHTML } from 'linkedom';

// Trimmed from the redesigned themes page (online-store-web.shopifyapps.com/themes).
const themeItem = (id: string, name: string, editPath: string) => `
  <li><div><div class="Polaris-Box"><div class="Polaris-InlineGrid">
    <div class="Polaris-Box"><div class="_LinkContainer_t079h_1">
      <a href="https://admin.shopify.com/store/demo-store/themes/${id}/${editPath}" aria-label="Edit ${name}">
        <div class="_ThemeListThumbnail_hvi45_1"><s-image alt="Theme preview thumbnail for ${name}"></s-image></div>
      </a>
    </div></div>
    <div class="Polaris-Box"><div class="_ThemeContent_dwfss_31">
      <div class="Polaris-BlockStack">
        <div class="Polaris-InlineStack"><h3 class="Polaris-Text--root">${name}</h3></div>
        <span class="Polaris-Text--root"><span class="_ThemeStatus_1v1vk_1">Last saved: 3:16 pm</span></span>
      </div>
      <div class="Polaris-InlineStack">
        <s-internal-button-group><div slot="secondary-actions"><s-internal-button>Publish</s-internal-button></div></s-internal-button-group>
        <span data-component-name="theme-index-customize-button">
          <a href="https://admin.shopify.com/store/demo-store/themes/${id}/${editPath}" class="_ThemeActionButton_xaf5q_1 _primary_xaf5q_36">Edit theme</a>
        </span>
        <button class="_ThemeActionButton_xaf5q_1 _tertiary_xaf5q_66 _small_xaf5q_75" type="button" commandfor=":r8:" command="--toggle"><s-internal-icon type="menu-horizontal"></s-internal-icon></button>
      </div>
    </div></div>
  </div></div></div></li>`;

// Trimmed from the live theme card at the top of the same page.
const publishedTheme = (id: string, name: string) => `
  <div class="_PublishedTheme_1nfrl_1">
    <a href="https://admin.shopify.com/store/demo-store/themes/${id}/editor" class="Polaris-Link" aria-label="Edit theme">
      <span class="_ThemePreview_1nfrl_8"><img alt="Theme preview screenshot"></span>
    </a>
    <div class="Polaris-Box"><div class="_ThemeInformationContainer_1nfrl_109"><div class="_ThemeInformation_1nfrl_109">
      <div class="_ThemeContent_1nfrl_134"><div class="Polaris-BlockStack">
        <div class="_PublishedThemeDomain_7wbza_31"><div class="Polaris-InlineStack">
          <s-internal-heading-display level="2" size="small"><button type="button">demo-store.myshopify.com</button></s-internal-heading-display>
          <a href="https://admin.shopify.com/store/demo-store/settings/domains" aria-label="Domain settings"></a>
        </div></div>
        <s-internal-text size="base">${name} · Last saved: Wednesday at 1:43 pm</s-internal-text>
      </div></div>
      <div class="_ThemeActions_1nfrl_144"><div class="Polaris-InlineStack">
        <span data-component-name="theme-index-customize-button">
          <a href="https://admin.shopify.com/store/demo-store/themes/${id}/editor" class="_ThemeActionButton_xaf5q_1 _primary_xaf5q_36" aria-label="Edit ${name}">Edit theme</a>
        </span>
        <button class="_ThemeActionButton_xaf5q_1 _tertiary_xaf5q_66 _small_xaf5q_75 _PublishedThemeAction_1x4mc_5" type="button" commandfor=":r3:" command="--toggle"><s-internal-icon type="menu-horizontal"></s-internal-icon></button>
        <s-popover id=":r3:"><ul class="Polaris-Box"><li class="Polaris-Box">
          <a class="Polaris-ActionList__Item" href="https://admin.shopify.com/store/demo-store/themes/${id}">Edit code</a>
        </li></ul></s-popover>
      </div></div>
    </div></div></div>
  </div>`;

const dom = parseHTML(`<html><body>
  <div class="Polaris-BlockStack">
    ${publishedTheme('158745460950', 'Prod')}
    <s-internal-section padding="none">
      <ul class="_ThemeList_11pt9_1 _NewThemeList_11pt9_19">
        ${themeItem('188431433942', 'Copy of Horizon', 'canvas?editorEntry=themeIndex')}
        ${themeItem('159845974230', 'Horizon', 'editor')}
      </ul>
    </s-internal-section>
  </div>
</body></html>`);
const { document } = dom;

// Toast.show (reached via confirmAndDeleteSelected) defines a custom element extending
// HTMLElement at module load, so these globals must exist before theme-list.util is imported.
// confirm is stubbed too: the real one blocks on stdin in this test runner.
const g = globalThis as Record<string, unknown>;
// window only needs a location: deletes check they're still on the themes page.
const saved = ['document', 'window', 'HTMLElement', 'customElements', 'requestAnimationFrame', 'confirm'].map(
  (k) => [k, g[k]] as const
);
let confirmResult = true;
Object.assign(g, {
  document,
  window: { location: { pathname: '/store/demo-store/themes' } },
  HTMLElement: dom.HTMLElement,
  customElements: dom.customElements,
  requestAnimationFrame: (cb: () => void) => setTimeout(cb, 0),
  confirm: () => confirmResult
});

// Mirrors the real s-checkbox just enough for tests: a real <input type="checkbox"> inside an
// open shadow root, attached on connect like the page's own custom element does. Like the real
// one, the checkmark it draws is its own state: `checked` set from code moves it only until the
// user clicks it (like a native input's dirty checkedness), a click toggles it, and writes to
// the inner input from code don't show at all.
class FakeCheckbox extends dom.HTMLElement {
  #shown = false;
  #touched = false;
  #input: HTMLInputElement | null = null;
  get checked() {
    return this.#shown;
  }
  set checked(value: boolean) {
    if (this.#touched) return;
    this.#shown = value;
    if (this.#input) this.#input.checked = value;
  }
  connectedCallback() {
    if (this.shadowRoot) return;
    const input = dom.document.createElement('input') as HTMLInputElement;
    input.type = 'checkbox';
    input.checked = this.#shown;
    // linkedom has no click activation behavior; this is what a browser's does for a checkbox,
    // plus the component's own handling: take the new state and re-dispatch change on the host.
    input.click = () => {
      if (this.hasAttribute('disabled')) return;
      input.checked = !input.checked;
      this.#touched = true;
      this.#shown = input.checked;
      this.dispatchEvent(new dom.Event('change', { bubbles: true }));
    };
    this.#input = input;
    this.attachShadow({ mode: 'open' }).append(input);
  }
}
dom.customElements.define('s-checkbox', FakeCheckbox);

const { injectIntoThemeList } = await import('../theme-list.util');

afterAll(() => {
  for (const [k, v] of saved) g[k] = v;
});

const ALFRED_SELECTOR = '[data-alfred-theme-list], [data-alfred-theme-checkbox], [data-alfred-bulk-toolbar]';
const injected = () => [...document.querySelectorAll('[data-alfred-theme-list]')];
const checkboxes = () => [...document.querySelectorAll<HTMLElement>('[data-alfred-theme-checkbox]')];
// The real toggle state lives on the <input> inside the checkbox's shadow root, same as production.
const checkboxInput = (checkbox: HTMLElement) =>
  checkbox.shadowRoot!.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
// What the user sees: the checkmark the component draws from its own state.
const shownChecked = (checkbox: HTMLElement) => (checkbox as HTMLElement & { checked: boolean }).checked;
// A user's click, if the checkbox isn't already showing `value`.
const toggleCheckbox = (checkbox: HTMLElement, value: boolean) => {
  if (shownChecked(checkbox) !== value) checkboxInput(checkbox).click();
};
const toolbar = () => document.querySelector<HTMLElement>('[data-alfred-bulk-toolbar]');
const toolbarVisible = () => toolbar()?.classList.contains('alfred-bulk-toolbar--show') ?? false;
const copyValues = (row: Element) =>
  [...row.querySelectorAll('s-internal-button')].map((b) => b.getAttribute('data-copy-value'));

describe('injectIntoThemeList', () => {
  beforeEach(() => document.querySelectorAll(ALFRED_SELECTOR).forEach((el) => el.remove()));

  it('adds ID and preview URL buttons below the live theme and each library theme, including Canvas themes', () => {
    expect(injectIntoThemeList()).toBe(true);

    const wrappers = injected();
    expect(wrappers.map(copyValues)).toEqual([
      ['158745460950', 'https://demo-store.myshopify.com/?preview_theme_id=158745460950'],
      ['188431433942', 'https://demo-store.myshopify.com/?preview_theme_id=188431433942'],
      ['159845974230', 'https://demo-store.myshopify.com/?preview_theme_id=159845974230']
    ]);
    for (const wrapper of wrappers) {
      expect(wrapper.parentElement?.lastElementChild).toBe(wrapper);
      expect(wrapper.parentElement?.querySelector('a[class*="ThemeActionButton"]')?.textContent).toBe('Edit theme');
    }
  });

  it('renders tertiary Polaris buttons with clipboard icons, then an inert copy of the more-actions button', () => {
    injectIntoThemeList();

    const row = injected()[0];
    const buttons = [...row.querySelectorAll('s-internal-button')];
    expect(buttons.map((b) => [b.textContent, b.getAttribute('variant'), b.getAttribute('icon')])).toEqual([
      ['ID', 'tertiary', 'clipboard'],
      ['Preview URL', 'tertiary', 'clipboard']
    ]);
    const spacer = row.lastElementChild as HTMLElement;
    expect(spacer.tagName).toBe('BUTTON');
    expect(spacer.hasAttribute('inert')).toBe(true);
    expect(spacer.hasAttribute('commandfor')).toBe(false);
  });

  it('skips injected items and restores buttons React re-rendered away', () => {
    injectIntoThemeList();
    expect(injectIntoThemeList()).toBe(false);

    injected()[0].remove();
    expect(injectIntoThemeList()).toBe(true);
    expect(injected()).toHaveLength(3);
  });

  it('adds a selection checkbox for each library theme, but not the live theme', () => {
    injectIntoThemeList();

    expect(checkboxes()).toHaveLength(2);
    expect(checkboxes().every((checkbox) => checkbox.tagName === 'S-CHECKBOX')).toBe(true);
    expect(checkboxes().every((checkbox) => checkbox.hasAttribute('accessibilitylabel'))).toBe(true);
  });

  it('adds the toolbar as a direct child of <body>, floating free of the themes list and its manually-slotted <s-internal-section>', () => {
    injectIntoThemeList();

    expect(toolbar()?.parentElement).toBe(document.body);
    expect(toolbar()?.closest('s-internal-section')).toBeNull();
  });
});

describe('bulk delete', () => {
  const NAMES = ['Alpha', 'Beta', 'Gamma'];
  const list = () => document.querySelector('ul[class*="ThemeList"]')!;
  const card = (name: string) =>
    [...document.querySelectorAll('li')].find((li) => li.querySelector('h3')?.textContent === name);
  const checkboxOf = (name: string) => card(name)!.querySelector<HTMLElement>('[data-alfred-theme-checkbox]')!;
  const checkedNames = () => NAMES.filter((name) => card(name) && shownChecked(checkboxOf(name)));
  const remaining = () => NAMES.filter((name) => card(name));
  const button = (action: string) => toolbar()!.querySelector<HTMLElement>(`[data-action="${action}"]`)!;
  const click = (el: Element) => el.dispatchEvent(new dom.Event('click', { bubbles: true }));
  const countText = () => toolbar()?.querySelector('.alfred-bulk-toolbar__count')?.textContent;
  const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));
  const waitUntil = async (check: () => boolean) => {
    for (let i = 0; i < 300 && !check(); i++) await tick();
  };
  const select = (...names: string[]) => names.forEach((name) => toggleCheckbox(checkboxOf(name), true));
  const toastTexts = () =>
    [...document.querySelectorAll('alfred-toast')].map(
      (toast) => toast.shadowRoot!.querySelector('.alfred-toast__text')!.textContent
    );

  // Stand-ins for Shopify's own UI. Each theme gets its own "more actions" popover whose
  // destructive "Delete" item either removes the theme straight away or opens a confirmation
  // dialog, where Cancel just closes it and "Delete theme" removes the theme too.
  const stubMenu = (name: string, mode: 'dialog' | 'immediate') => {
    const li = card(name)!;
    const moreButton = li.querySelector('button[commandfor]')!;
    const popover = document.createElement('s-popover');
    popover.id = `menu-${name}`;
    moreButton.setAttribute('commandfor', popover.id);
    popover.innerHTML = '<button type="button" class="Polaris-ActionList--destructive">Delete</button>';
    popover.querySelector('button')!.addEventListener('click', () => {
      if (mode === 'immediate') {
        li.remove();
        return;
      }
      const dialog = document.createElement('div');
      dialog.setAttribute('role', 'dialog');
      dialog.innerHTML = `<h2>Delete ${name}?</h2><button type="button">Cancel</button><button type="button">Delete theme</button>`;
      const [cancel, confirm] = dialog.querySelectorAll('button');
      cancel.addEventListener('click', () => dialog.remove());
      confirm.addEventListener('click', () => {
        li.remove();
        dialog.remove();
      });
      document.body.append(dialog);
    });
    moreButton.after(popover);
  };
  // Waits for the named theme's dialog, then answers it like the user would.
  const answerDialog = async (name: string, answer: 'Cancel' | 'Delete theme') => {
    const dialog = () =>
      [...document.querySelectorAll('[role="dialog"]')].find((d) => d.textContent?.includes(`Delete ${name}?`));
    await waitUntil(() => !!dialog());
    click([...dialog()!.querySelectorAll('button')].find((b) => b.textContent === answer)!);
  };
  const expectIdle = (selected: number) => {
    expect(button('cancel').textContent).toBe('Cancel');
    expect(button('cancel').hasAttribute('disabled')).toBe(false);
    expect(button('delete').hasAttribute('disabled')).toBe(false);
    expect(button('select-all').hasAttribute('disabled')).toBe(false);
    expect(toolbarVisible()).toBe(selected > 0);
    if (selected > 0) {
      expect(countText()).toBe(`${selected} theme${selected === 1 ? '' : 's'} selected`);
    }
  };

  beforeEach(() => {
    if (toolbar()) click(button('cancel')); // clears whatever selection the last test left
    document.querySelectorAll('[role="dialog"], s-popover[id^="menu-"]').forEach((el) => el.remove());
    list().innerHTML = NAMES.map((name, i) => themeItem(`${i + 1}00`, name, 'editor')).join('');
    confirmResult = true;
    injectIntoThemeList();
  });

  it('shows the toolbar only while themes are checked, with an accurate count', () => {
    expectIdle(0);

    select('Alpha');
    expectIdle(1);
    select('Beta');
    expectIdle(2);

    toggleCheckbox(checkboxOf('Alpha'), false);
    toggleCheckbox(checkboxOf('Beta'), false);
    expectIdle(0);
  });

  it('Cancel deselects every theme and hides the toolbar without deleting anything', () => {
    select('Alpha', 'Beta', 'Gamma');
    expectIdle(3);

    click(button('cancel'));

    expect(checkedNames()).toEqual([]);
    expectIdle(0);
    expect(remaining()).toEqual(NAMES);
  });

  it('Select all checks every library theme (never the live one), and toggles to Deselect all', () => {
    select('Alpha');
    expect(button('select-all').textContent).toBe('Select all');

    click(button('select-all'));
    expect(checkedNames()).toEqual(NAMES);
    expectIdle(3);
    expect(button('select-all').textContent).toBe('Deselect all');

    click(button('select-all'));
    expect(checkedNames()).toEqual([]);
    expectIdle(0);
  });

  it('Select all, Deselect all and Cancel also move checkboxes the user clicked by hand', () => {
    // Regression: once clicked, s-checkbox stops following `checked` set from code, so boxes
    // the user had clicked kept their checkmark through Select all / Deselect all.
    select('Alpha');
    toggleCheckbox(checkboxOf('Beta'), true);
    toggleCheckbox(checkboxOf('Beta'), false);

    click(button('select-all'));
    expect(checkedNames()).toEqual(NAMES);
    expectIdle(3);

    click(button('select-all'));
    expect(checkedNames()).toEqual([]);
    expectIdle(0);

    select('Alpha', 'Gamma');
    click(button('select-all'));
    click(button('cancel'));
    expect(checkedNames()).toEqual([]);
    expectIdle(0);
  });

  it('keeps a checkbox checked when React re-renders it away and Alfred adds it back', () => {
    select('Beta');
    checkboxOf('Beta').remove();

    injectIntoThemeList();

    expect(checkedNames()).toEqual(['Beta']);
    expectIdle(1);
  });

  it("drops a selected theme from the count once it's gone from the page", () => {
    select('Alpha', 'Beta');
    card('Alpha')!.remove(); // e.g. deleted from Shopify's own menu

    injectIntoThemeList();

    expectIdle(1);
  });

  it("doesn't touch the DOM on a pass where nothing changed, so the observer can't feed itself", async () => {
    // Regression: rewriting the buttons' text on every pass was itself a mutation, which
    // re-triggered the observer every frame and rebuilt the Cancel button's contents under the
    // pointer, so its clicks never landed.
    select('Alpha', 'Beta');
    const records: unknown[] = [];
    const observer = new dom.MutationObserver((batch: unknown[]) => records.push(...batch));
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });

    injectIntoThemeList();
    injectIntoThemeList();
    await tick();

    observer.disconnect();
    // Compared by count: printing a failing diff of DOM-holding records never finishes.
    expect(records.length).toBe(0);
  });

  it('does nothing when the initial confirmation is cancelled', async () => {
    select('Alpha', 'Beta', 'Gamma');
    NAMES.forEach((name) => stubMenu(name, 'immediate'));

    confirmResult = false;
    click(button('delete'));
    await tick(100);

    expect(remaining()).toEqual(NAMES);
    expect(checkedNames()).toEqual(NAMES);
    expectIdle(3);
  });

  it("skips a theme canceled in Shopify's dialog and carries on with the rest", async () => {
    select('Alpha', 'Beta', 'Gamma');
    NAMES.forEach((name) => stubMenu(name, 'dialog'));

    click(button('delete'));
    await waitUntil(() => countText() === 'Deleting 1 of 3 themes…');
    expect(countText()).toBe('Deleting 1 of 3 themes…');
    expect(button('cancel').textContent).toBe('Stop');
    expect(button('delete').hasAttribute('disabled')).toBe(true);
    expect(checkboxOf('Gamma').hasAttribute('disabled')).toBe(true);

    await answerDialog('Alpha', 'Cancel');
    await answerDialog('Beta', 'Delete theme');
    await answerDialog('Gamma', 'Delete theme');
    await waitUntil(() => countText() === '1 theme selected');

    expect(remaining()).toEqual(['Alpha']);
    expect(checkedNames()).toEqual(['Alpha']);
    expect(checkboxOf('Alpha').hasAttribute('disabled')).toBe(false);
    expectIdle(1);
    await waitUntil(() => toastTexts().at(-1) === 'Deleted 2 themes, skipped 1 you canceled.');
    expect(toastTexts().at(-1)).toBe('Deleted 2 themes, skipped 1 you canceled.');
  }, 10000);

  it('ignores checkbox changes while a delete is running', async () => {
    select('Alpha', 'Beta');
    stubMenu('Alpha', 'dialog');
    stubMenu('Beta', 'immediate');

    click(button('delete'));
    await waitUntil(() => !!document.querySelector('[role="dialog"]'));
    toggleCheckbox(checkboxOf('Beta'), false);
    toggleCheckbox(checkboxOf('Gamma'), true);

    expect(checkedNames()).toEqual(['Alpha', 'Beta']);
    await answerDialog('Alpha', 'Delete theme');
    await waitUntil(() => !toolbarVisible());

    expect(remaining()).toEqual(['Gamma']);
    expectIdle(0);
  }, 10000);

  it('Stop ends the run after the current theme and keeps the rest selected', async () => {
    select('Alpha', 'Beta', 'Gamma');
    NAMES.forEach((name) => stubMenu(name, 'dialog'));

    click(button('delete'));
    await waitUntil(() => !!document.querySelector('[role="dialog"]'));
    click(button('cancel'));
    expect(button('cancel').textContent).toBe('Stopping…');
    expect(button('cancel').hasAttribute('disabled')).toBe(true);

    await answerDialog('Alpha', 'Delete theme');
    await waitUntil(() => countText() === '2 themes selected');

    expect(remaining()).toEqual(['Beta', 'Gamma']);
    expect(checkedNames()).toEqual(['Beta', 'Gamma']);
    expectIdle(2);
    await waitUntil(() => toastTexts().at(-1) === 'Deleted 1 theme, stopped before 2.');
    expect(toastTexts().at(-1)).toBe('Deleted 1 theme, stopped before 2.');
  }, 10000);

  it('treats a theme as deleted when Shopify removes it immediately, with no confirmation dialog', async () => {
    // Some themes (seen for drafts) delete immediately from the menu with no second dialog.
    select('Alpha');
    stubMenu('Alpha', 'immediate');

    click(button('delete'));
    await waitUntil(() => !toolbarVisible());

    expect(remaining()).toEqual(['Beta', 'Gamma']);
    expectIdle(0);
  });

  it('works again after a completed delete without a reload: select, cancel, delete', async () => {
    select('Alpha');
    stubMenu('Alpha', 'immediate');
    click(button('delete'));
    await waitUntil(() => !toolbarVisible());
    expect(remaining()).toEqual(['Beta', 'Gamma']);

    select('Beta', 'Gamma');
    expectIdle(2);
    click(button('cancel'));
    expect(checkedNames()).toEqual([]);
    expectIdle(0);

    select('Gamma');
    stubMenu('Gamma', 'immediate');
    click(button('delete'));
    await waitUntil(() => !toolbarVisible());
    expect(remaining()).toEqual(['Beta']);
    expectIdle(0);
  });
});
