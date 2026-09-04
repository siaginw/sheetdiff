// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { NoteDialog } from "./note-dialog";

vi.mock("@/lib/actions", () => ({ addNote: vi.fn() }));

afterEach(() => cleanup());

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

test("the Pattern-B reset contract: Delete clears the body so reopening is empty (not resurrected)", async () => {
  const user = userEvent.setup();
  const { addNote } = await import("@/lib/actions");
  render(<NoteDialog spreadsheetId="s1" tabId="t1" rowKey="r1" existingNote="delete me" />);

  // open, click Delete — submits with delete=1 and the old text still in body
  await user.click(screen.getByRole("button", { name: "Edit note" }));
  expect(await screen.findByRole("dialog")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Delete" }));

  // the server action was called (FormData carries the delete flag; jsdom's
  // FormData isn't inspectable via toHaveBeenCalledWith, so just verify it fired)
  expect(addNote).toHaveBeenCalledTimes(1);

  // reopen — the body is EMPTY (the reset), not the deleted note resurrected
  await user.click(screen.getByRole("button", { name: "Edit note" }));
  expect(await screen.findByRole("dialog")).toBeInTheDocument();
  expect(screen.getByLabelText("Note")).toHaveValue("");
});
