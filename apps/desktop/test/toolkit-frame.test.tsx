// @vitest-environment happy-dom
import { act, useState } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { ToolkitPopover } from "../src/renderer/src/components/performance/PerformancePopover";
import { ToolkitActions } from "../src/renderer/src/components/toolkit/ToolkitActions";
import { composerDOM } from "./helpers/composer-dom-fixture";

const dom = composerDOM();
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Element.prototype.scrollIntoView = vi.fn();
});
function Consumer({
  run,
  secondary,
  disabled = false,
}: {
  run(): void;
  secondary(): void;
  disabled?: boolean;
}) {
  const [selected, select] = useState<string | symbol | null>(null);
  return (
    <>
      <input aria-label="Original draft" defaultValue="Keep this draft" />
      <ToolkitPopover
        toolId="frame"
        name="Frame tool"
        icon={<span />}
        selectedToolId={selected}
        onSelectTool={select}
      >
        {(close) => (
          <>
            <header className="performance-header">
              <h2>Frame tool</h2>
              <button data-toolkit-close onClick={close}>
                Close frame
              </button>
            </header>
            <div className="performance-body">Original result</div>
            <ToolkitActions
              primary={
                <button disabled={disabled} onClick={run}>
                  Run the saved report with its complete original descriptive
                  name
                </button>
              }
            >
              <button onClick={secondary}>
                Inspect every original result in the selected workspace
              </button>
            </ToolkitActions>
          </>
        )}
      </ToolkitPopover>
    </>
  );
}
const query = <T extends Element = HTMLElement>(selector: string): T => {
  const element = document.querySelector<T>(selector);
  expect(element, selector).not.toBeNull();
  return element!;
};
async function key(element: Element, key: string) {
  await act(async () =>
    element.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
    ),
  );
}
async function openMenu() {
  const button = query<HTMLButtonElement>(".toolkit-actions__more");
  await act(async () => button.focus());
  await key(button, "Enter");
  expect(query('[role="menu"]').closest(".performance-popover")).not.toBeNull();
}

it("reuses complete primary and secondary button callbacks in the same DOM menu", async () => {
  const run = vi.fn(),
    secondary = vi.fn();
  await dom.render(<Consumer run={run} secondary={secondary} />);
  await dom.click('[data-toolkit-id="frame"]');
  await act(async () =>
    query<HTMLButtonElement>(
      ".performance-actions > button:first-child",
    ).click(),
  );
  expect(run).toHaveBeenCalledOnce();
  await openMenu();
  const items = [
    ...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
  ];
  expect(items.map((item) => item.textContent)).toEqual([
    "Run the saved report with its complete original descriptive name",
    "Inspect every original result in the selected workspace",
  ]);
  await act(async () => items[1]!.click());
  expect(secondary).toHaveBeenCalledOnce();
  expect(run).toHaveBeenCalledOnce();
  expect(document.querySelector('[role="menu"]')).toBeNull();
  expect(document.querySelector(".performance-popover")).not.toBeNull();
});
it("lets the menu consume the first Escape and the original panel consume the second", async () => {
  await dom.render(<Consumer run={vi.fn()} secondary={vi.fn()} />);
  await dom.click('[data-toolkit-id="frame"]');
  await openMenu();
  const item = query<HTMLButtonElement>('[role="menuitem"]');
  await act(async () => item.focus());
  await key(item, "Escape");
  expect(document.querySelector('[role="menu"]')).toBeNull();
  expect(document.querySelector(".performance-popover")).not.toBeNull();
  await vi.waitFor(() =>
    expect(document.activeElement).toBe(query(".toolkit-actions__more")),
  );
  await key(document.activeElement!, "Escape");
  expect(document.querySelector(".performance-popover")).toBeNull();
});
it("keeps disabled primary actions unavailable in both presentations and invokes an enabled item by keyboard once", async () => {
  const run = vi.fn(),
    secondary = vi.fn();
  await dom.render(<Consumer run={run} secondary={secondary} disabled />);
  await dom.click('[data-toolkit-id="frame"]');
  await openMenu();
  const items = [
    ...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
  ];
  expect(items[0]!.disabled).toBe(true);
  expect(items[0]!.getAttribute("data-disabled")).not.toBeNull();
  await act(async () => items[1]!.focus());
  await key(items[1]!, "Enter");
  expect(run).not.toHaveBeenCalled();
  expect(secondary).toHaveBeenCalledOnce();
});
it("closes the original panel on an outside press without sending an action", async () => {
  const run = vi.fn(),
    secondary = vi.fn();
  await dom.render(<Consumer run={run} secondary={secondary} />);
  await dom.click('[data-toolkit-id="frame"]');
  await openMenu();
  await act(async () =>
    query("input").dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, button: 0 }),
    ),
  );
  expect(document.querySelector(".performance-popover")).toBeNull();
  expect(run).not.toHaveBeenCalled();
  expect(secondary).not.toHaveBeenCalled();
  expect(query<HTMLInputElement>("input").value).toBe("Keep this draft");
});
