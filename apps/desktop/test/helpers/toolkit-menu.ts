import { act } from "react";
import { expect } from "vitest";

export async function openToolkitMenu(root: ParentNode = document) {
  const trigger = root.querySelector<HTMLButtonElement>(
    ".toolkit-actions__more",
  );
  expect(trigger, "The real action menu trigger is connected").not.toBeNull();
  await act(async () => {
    trigger!.focus();
    trigger!.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  expect(root.querySelector('[role="menu"]')).not.toBeNull();
}

export async function clickToolkitMenu(
  label: string,
  root: ParentNode = document,
) {
  await openToolkitMenu(root);
  const item = [
    ...root.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
  ].find((node) => node.textContent?.trim() === label);
  expect(
    item,
    "The complete original action label is available: " + label,
  ).toBeDefined();
  await act(async () => item!.click());
}
