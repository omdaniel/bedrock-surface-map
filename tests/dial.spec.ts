import { test, expect, type Page } from "@playwright/test";

test.use({ hasTouch: true });

async function openDial(page: Page) {
  await page.goto("/?map=/maps/fixture/manifest.json");
  await page.waitForFunction(() => window.__map?.ready);
  await page
    .getByRole("button", { name: "Lighting and color", exact: true })
    .click();
  const dial = page.getByRole("slider", { name: "Sun azimuth" });
  await expect(dial).toBeVisible();
  return dial;
}

test("compass dial supports multiple pointer revolutions without changing the camera", async ({
  page,
}) => {
  const dial = await openDial(page);
  const before = (await page.evaluate(() => window.__map.state())) as {
    cx: number;
    cz: number;
    scale: number;
  };
  const box = (await dial.boundingBox())!;
  const cx = box.x + box.width / 2,
    cy = box.y + box.height / 2;
  const move = async (angle: number, radius = 38) => {
    await page.mouse.move(
      cx + Math.sin((angle * Math.PI) / 180) * radius,
      cy - Math.cos((angle * Math.PI) / 180) * radius,
    );
  };
  await move(0);
  await page.mouse.down();
  for (let turn = 0; turn < 3; turn++) {
    for (let angle = 45; angle <= 360; angle += 45) {
      await move(angle);
      await expect(dial).toHaveAttribute("aria-valuenow", String(angle % 360));
    }
  }
  for (let turn = 0; turn < 2; turn++) {
    for (let angle = -45; angle >= -360; angle -= 45) {
      await move(angle);
      await expect(dial).toHaveAttribute(
        "aria-valuenow",
        String((angle + 360) % 360),
      );
    }
  }
  // Capture keeps the drag active outside the dial; release stops subsequent movement.
  await move(270, 160);
  await expect(dial).toHaveAttribute("aria-valuenow", "270");
  await page.mouse.up();
  await move(90);
  await expect(dial).toHaveAttribute("aria-valuenow", "270");
  await page.mouse.click(cx, cy); // The center does not have a meaningful bearing.
  await expect(dial).toHaveAttribute("aria-valuenow", "270");
  await page.mouse.click(cx + 38, cy, { button: "right" });
  await page.keyboard.press("Escape");
  await expect(dial).toHaveAttribute("aria-valuenow", "270");
  expect(await dial.boundingBox()).toEqual(box);
  const after = await page.evaluate(() => window.__map.state());
  expect(after).toMatchObject({
    cx: before.cx,
    cz: before.cz,
    scale: before.scale,
    azimuth: 270,
  });
  await page.screenshot({ path: "test-results/dial-desktop.png" });
});

test("compass dial is keyboard accessible and wraps instead of hitting an endpoint", async ({
  page,
}) => {
  const dial = await openDial(page);
  await dial.focus();
  await expect(dial).toBeFocused();
  await expect(dial).toHaveAttribute(
    "aria-valuetext",
    "330 degrees clockwise from north",
  );
  for (const [key, value] of [
    ["Home", 0],
    ["ArrowLeft", 359],
    ["ArrowRight", 0],
    ["ArrowDown", 359],
    ["ArrowUp", 0],
    ["PageDown", 345],
    ["PageUp", 0],
    ["End", 359],
    ["ArrowUp", 0],
  ] as const) {
    await dial.press(key);
    await expect(dial).toHaveAttribute("aria-valuenow", String(value));
    await expect(page.locator("#azimuth-value")).toHaveText(`${value}°`);
    expect(await page.evaluate(() => window.__map.state())).toMatchObject({
      azimuth: value,
    });
  }
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Sun elevation")).toBeFocused();
});

test("compass dial handles touch rotation, cancellation and a new gesture", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const dial = await openDial(page);
  const box = (await dial.boundingBox())!;
  const cdp = await page.context().newCDPSession(page);
  const touch = async (
    type: "touchStart" | "touchMove" | "touchEnd" | "touchCancel",
    angle = 0,
  ) => {
    await cdp.send("Input.dispatchTouchEvent", {
      type,
      touchPoints:
        type === "touchEnd" || type === "touchCancel"
          ? []
          : [
              {
                x:
                  box.x +
                  box.width / 2 +
                  38 * Math.sin((angle * Math.PI) / 180),
                y:
                  box.y +
                  box.height / 2 -
                  38 * Math.cos((angle * Math.PI) / 180),
                id: 1,
              },
            ],
    });
  };
  await touch("touchStart", 345);
  for (const angle of [350, 355, 0, 5, 90, 180, 270, 355, 0, 5]) {
    await touch("touchMove", angle);
    await expect(dial).toHaveAttribute("aria-valuenow", String(angle));
  }
  await touch("touchCancel");
  await expect(dial).not.toHaveClass(/dragging/);
  await touch("touchStart", 90);
  await expect(dial).toHaveAttribute("aria-valuenow", "90");
  await touch("touchEnd");
  await expect(dial).not.toHaveClass(/dragging/);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: "test-results/dial-touch.png" });
  await cdp.detach();
});
