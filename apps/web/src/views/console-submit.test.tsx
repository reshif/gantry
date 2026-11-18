import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { updatePrefs } from "../lib/prefs";
import ConsoleSubmitView from "./console-submit";
import { mockApi, mount, resetApp } from "./floor/testkit";

beforeEach(() => {
  resetApp();
  updatePrefs({ project: "payments" });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const title = () => screen.findByLabelText(/^Title/) as Promise<HTMLInputElement>;

describe("Console (submit a work order, prototype layout)", () => {
  it("shows the form beside the route preview and recent submissions, and validates the title before submitting", async () => {
    const cs = mockApi();
    mount(<ConsoleSubmitView />);
    expect(await screen.findByText("New work order")).toBeTruthy();
    expect(screen.getByText("Route preview")).toBeTruthy();
    expect(screen.getByText("Recent submissions")).toBeTruthy();
    expect(document.querySelector("form.card")).toBeTruthy();
    const submit = await screen.findByRole("button", { name: "Submit work order" });
    await waitFor(() => expect(submit.getAttribute("aria-disabled")).not.toBe("true"));
    fireEvent.click(submit);
    // the error sits on the field, the field is marked invalid and takes focus
    expect(await screen.findByText("Title is required.")).toBeTruthy();
    expect((await title()).getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(await title());
    fireEvent.change(await title(), { target: { value: "Fix it" } });
    fireEvent.click(submit);
    expect(await screen.findByText("Title needs at least 8 characters.")).toBeTruthy();
    expect(cs.some((c) => c.method === "POST" && c.path.endsWith("/work-orders"))).toBe(false);
  });

  it("has the prototype form: label, placeholder, hint, field order, template select, no Source and no Chat button", async () => {
    mockApi();
    mount(<ConsoleSubmitView />);
    const t = await title();
    expect(t.placeholder).toBe("What should change?");
    expect(screen.getByText("A short imperative sentence.")).toBeTruthy();
    const d = screen.getByLabelText("Description") as HTMLTextAreaElement;
    expect(d.placeholder).toBe("Context, acceptance criteria, links");
    expect(d.rows).toBe(5);
    expect(Array.from(document.querySelectorAll("#conform .field label, #conform .field .lbl")).map((e) => e.textContent).filter((x) => /^(Title|Description|Project|Repository|Class|Priority|Attachments)/.test(x ?? ""))).toEqual(["Title (required)", "Description", "Project", "Repository", "Class", "Priority", "Attachments"]);
    const tpl = screen.getByLabelText("Template") as HTMLSelectElement;
    expect(Array.from(tpl.options).map((o) => o.textContent)).toEqual(["Start from template…", "Bug report", "Feature request", "Dependency chore"]);
    expect(Array.from((screen.getByLabelText("Priority") as HTMLSelectElement).options).map((o) => o.value)).toEqual(["P1", "P2", "P3"]);
    expect((screen.getByLabelText("Priority") as HTMLSelectElement).value).toBe("P2");
    expect((screen.getByLabelText("Class") as HTMLSelectElement).options[0]!.textContent).toBe("Let Gantry classify");
    expect(screen.queryByLabelText("Source")).toBeNull();
    expect(screen.queryByRole("button", { name: /Chat with the Console/ })).toBeNull();
  });

  it("a template fills title, description and class; Reset clears them", async () => {
    mockApi();
    mount(<ConsoleSubmitView />);
    await title();
    fireEvent.change(screen.getByLabelText("Template"), { target: { value: "bug" } });
    expect((await title()).value).toBe("Fix: ");
    expect((screen.getByLabelText("Description") as HTMLTextAreaElement).value).toMatch(/Steps to reproduce/);
    expect((screen.getByLabelText("Class") as HTMLSelectElement).value).toBe("bug");
    // the select returns to "Start from template…" after filling the form
    expect((screen.getByLabelText("Template") as HTMLSelectElement).value).toBe("");
    fireEvent.click(document.getElementById("nwo-reset") as HTMLElement);
    expect((await title()).value).toBe("");
    expect((screen.getByLabelText("Class") as HTMLSelectElement).value).toBe("");
  });

  it("the route preview is the prototype's: Predicted class, a key-value list and the station pipeline with Intake current", async () => {
    mockApi();
    mount(<ConsoleSubmitView />);
    await title();
    const prev = document.getElementById("conprev") as HTMLElement;
    expect(prev.textContent).toMatch(/Predicted class/);
    const kv = Array.from(prev.querySelectorAll(".kv dt")).map((e) => e.textContent);
    expect(kv).toEqual(["Confidence", "Priority", "SLA", "Skips", "Gates", "Estimate"]);
    // nothing typed yet: the confidence is a dash, not a made-up percentage
    expect(prev.querySelector(".kv dd")?.textContent).toBe("—");
    const steps = prev.querySelectorAll(".pipe .st");
    expect(steps.length).toBeGreaterThanOrEqual(9);
    expect(steps[0]!.classList.contains("cur")).toBe(true);
    // choosing a class says so
    fireEvent.change(screen.getByLabelText("Class"), { target: { value: "bug" } });
    expect(prev.querySelector(".kv dd")?.textContent).toBe("you chose it");
  });

  it("attachments are tags with a Remove button, added with Attach file", async () => {
    mockApi();
    mount(<ConsoleSubmitView />);
    await title();
    const input = { files: [{ name: "trace.log" }], click: vi.fn(), type: "", multiple: false, onchange: null as null | (() => void) };
    const real = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tag: string, o?: ElementCreationOptions) => (tag === "input" ? (input as unknown as HTMLElement) : real(tag, o)));
    fireEvent.click(document.getElementById("nwo-attach") as HTMLElement);
    expect(input.type).toBe("file");
    input.onchange?.();
    expect((await screen.findByText("trace.log")).closest(".tag")).toBeTruthy();
    vi.restoreAllMocks();
    fireEvent.click(screen.getByRole("button", { name: "Remove trace.log" }));
    await waitFor(() => expect(screen.queryByText("trace.log")).toBeNull());
  });
});
