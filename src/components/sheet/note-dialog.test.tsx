// @vitest-environment jsdom
import { test, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";
import { NoteDialog } from "./note-dialog";

vi.mock("@/lib/actions", () => ({ addNote: vi.fn() }));

test("opening the dialog prefills the existing note; deleting clears it; reopening is fresh", async () => {
  const user = userEvent.setup();
  render(<NoteDialog spreadsheetId="s1" tabId="t1" rowKey="r1" existingNote="stale note" />);

  // closed initially
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

  // open — the existing note prefills
  await user.click(screen.getByRole("button", { name: "Edit note" }));
  expect(await screen.findByRole("dialog")).toBeInTheDocument();
  expect(screen.getByLabelText("Note")).toHaveValue("stale note");

  // cancel closes
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

  // reopen — still prefilled (state lives in the portal-unmounted body)
  await user.click(screen.getByRole("button", { name: "Edit note" }));
  expect(await screen.findByRole("dialog")).toBeInTheDocument();
  expect(screen.getByLabelText("Note")).toHaveValue("stale note");
});
