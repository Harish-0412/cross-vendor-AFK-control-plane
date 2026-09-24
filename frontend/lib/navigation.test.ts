import { describe, expect, it } from "vitest";

import { ALL_NAV_ITEMS, MOBILE_TAB_HREFS, isActivePath, titleForPath } from "./navigation";

describe("navigation", () => {
  it("lists every destination once", () => {
    const hrefs = ALL_NAV_ITEMS.map((item) => item.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it("only puts real destinations in the phone's tab bar", () => {
    for (const href of MOBILE_TAB_HREFS) {
      expect(ALL_NAV_ITEMS.some((item) => item.href === href)).toBe(true);
    }
  });

  it("treats a sub-page as inside its section, and a lookalike as not", () => {
    expect(isActivePath("/devices/pair", "/devices")).toBe(true);
    expect(isActivePath("/devices", "/devices")).toBe(true);
    // "/devicesettings" must not light up "/devices".
    expect(isActivePath("/devicesettings", "/devices")).toBe(false);
  });

  it("titles a page by its section", () => {
    expect(titleForPath("/sessions/ses_123")).toBe("Live sessions");
    expect(titleForPath("/nowhere")).toBe("Odysseus");
  });
});
