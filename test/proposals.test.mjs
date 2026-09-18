import assert from "node:assert/strict";
import test from "node:test";
import { IMAGE, addFullSources, fullFlow, makeServer, registerLineage } from "./helpers.mjs";

test("签约前可见与既有合同的独家窗口冲突", async (t) => {
  const { api } = await makeServer(t);
  await registerLineage(api);
  await addFullSources(api);
  // 厂商 A 已签下 2026 全年 CN 线上电商独家
  await fullFlow(api, {
    assetRef: IMAGE,
    licensee: "vendor-a",
    grantScope: { media: ["online"], territories: ["CN"], channels: ["e-commerce"], quantity: 1000, exclusive: true },
    window: ["2026-01-01", "2027-01-01"],
    exclusive: true,
  });

  // 厂商 B 申请重叠的独家窗口：冲突在提交方案时即可见
  const overlap = await api("POST", "/proposals", {
    licensee_ref: "vendor-b",
    asset_refs: [IMAGE],
    requested_scope: {
      media: ["online"],
      territories: ["CN"],
      channels: ["e-commerce"],
      valid_from: "2026-06-01",
      valid_to: "2027-01-01",
      exclusive: true,
    },
  });
  assert.equal(overlap.body.conflicts.length, 1);
  assert.equal(overlap.body.conflicts[0].kind, "contract");
  assert.deepEqual(overlap.body.conflicts[0].overlap.media, ["online"]);

  // 窗口首尾相接（闭开区间）不冲突
  const adjacent = await api("POST", "/proposals", {
    licensee_ref: "vendor-b",
    asset_refs: [IMAGE],
    requested_scope: {
      media: ["online"],
      territories: ["CN"],
      channels: ["e-commerce"],
      valid_from: "2027-01-01",
      valid_to: "2028-01-01",
      exclusive: true,
    },
  });
  assert.equal(adjacent.body.conflicts.length, 0);

  // 媒介不相交不冲突
  const otherMedia = await api("POST", "/proposals", {
    licensee_ref: "vendor-b",
    asset_refs: [IMAGE],
    requested_scope: {
      media: ["print"],
      territories: ["CN"],
      channels: ["e-commerce"],
      valid_from: "2026-06-01",
      valid_to: "2027-01-01",
      exclusive: true,
    },
  });
  assert.equal(otherMedia.body.conflicts.length, 0);
});

test("在途方案之间的独家冲突同样可见", async (t) => {
  const { api } = await makeServer(t);
  await registerLineage(api);
  const first = await api("POST", "/proposals", {
    licensee_ref: "vendor-a",
    asset_refs: [IMAGE],
    requested_scope: {
      media: ["online"],
      territories: ["CN"],
      channels: ["e-commerce"],
      valid_from: "2026-01-01",
      valid_to: "2027-01-01",
      exclusive: true,
    },
  });
  assert.equal(first.body.conflicts.length, 0);
  const second = await api("POST", "/proposals", {
    licensee_ref: "vendor-b",
    asset_refs: [IMAGE],
    requested_scope: {
      media: ["online"],
      territories: ["CN"],
      channels: ["e-commerce"],
      valid_from: "2026-06-01",
      valid_to: "2027-06-01",
      exclusive: true,
    },
  });
  assert.equal(second.body.conflicts.length, 1);
  assert.equal(second.body.conflicts[0].kind, "proposal");
  // 双方都不独家则不构成冲突
  const nonExclusive = await api("POST", "/proposals", {
    licensee_ref: "vendor-d",
    asset_refs: [IMAGE],
    requested_scope: {
      media: ["print"],
      territories: ["CN"],
      channels: ["offline"],
      valid_from: "2026-06-01",
      valid_to: "2027-06-01",
    },
  });
  assert.equal(nonExclusive.body.conflicts.length, 0);
});
