(() => {
  const data = window.TRAVEL_DATA;
  if (!data) {
    console.error("TRAVEL_DATA not found. Load data.js first.");
    return;
  }

  const { options, partyDefaults, calculationRules, fareRules } = data;
  const totalPeople = partyDefaults.total;

  const state = createInitialState();
  state.ui = {
    accordion: createInitialAccordionState(),
  };

  const el = {
    flight: document.getElementById("flight-options"),
    roomConfig: document.getElementById("roomConfig-options"),
    stayA: document.getElementById("stayA-options"),
    stayB: document.getElementById("stayB-options"),
    meal: document.getElementById("meal-options"),
    transport: document.getElementById("transport-options"),
    activityControls: document.getElementById("activity-controls"),
    activityPackOptions: document.getElementById("activityPack-options"),
    perPersonTotal: document.getElementById("per-person-total"),
    breakdown: document.getElementById("breakdown-list"),
    timeline: document.getElementById("timeline-list"),
    openEvidence: document.getElementById("open-evidence"),
    closeEvidence: document.getElementById("close-evidence"),
    evidenceModal: document.getElementById("evidence-modal"),
    evidenceAsOf: document.getElementById("evidence-asof"),
    evidenceSources: document.getElementById("evidence-sources"),
    summaryFlight: document.getElementById("summary-flight"),
    summaryRoomConfig: document.getElementById("summary-roomConfig"),
    summaryStayA: document.getElementById("summary-stayA"),
    summaryStayB: document.getElementById("summary-stayB"),
    summaryMeal: document.getElementById("summary-meal"),
    summaryTransport: document.getElementById("summary-transport"),
    summaryActivities: document.getElementById("summary-activities"),
    summaryActivityPack: document.getElementById("summary-activityPack"),
    categories: Array.from(document.querySelectorAll(".category[data-section]")),
  };

  bindEvents();
  render();
  renderEvidence();

  function createInitialAccordionState() {
    const mobile = window.matchMedia("(max-width: 768px)").matches;
    if (mobile) {
      return {
        flight: true,
        roomConfig: true,
        stayA: false,
        stayB: false,
        meal: false,
        transport: false,
        activities: true,
        activityPacks: false,
      };
    }

    return {
      flight: true,
      roomConfig: true,
      stayA: true,
      stayB: true,
      meal: true,
      transport: true,
      activities: true,
      activityPacks: true,
    };
  }

  function createInitialState() {
    const preset = data.scenarioPresets && data.scenarioPresets[0] ? data.scenarioPresets[0].selected : null;

    return {
      flightId: pickDefaultId(options.flight, preset && preset.flightId),
      roomConfigId: pickDefaultId(options.roomConfig, preset && preset.roomConfigId, { required: false }),
      stayAId: pickDefaultId(options.stayA_3nights, preset && preset.stayAId),
      stayBId: pickDefaultId(options.stayB_2nights, preset && preset.stayBId),
      mealLevelId: pickDefaultId(options.mealLevel, preset && preset.mealLevelId),
      transportId: pickDefaultId(options.transport, preset && preset.transportId),
      activityPackId: null,
      activities: createInitialActivitiesState(preset && preset.activities),
    };
  }

  function createInitialActivitiesState(presetActivities) {
    const result = {};
    const defs = options.activities || {};

    Object.entries(defs).forEach(([key, def]) => {
      const presetValue = presetActivities ? presetActivities[key] : undefined;
      if (isBooleanActivity(def)) {
        const nextValue = presetValue !== undefined ? presetValue : def.defaultEnabled;
        result[key] = Boolean(nextValue);
      } else {
        const defaultQty = presetValue !== undefined ? presetValue : def.defaultQty;
        result[key] = clampQty(defaultQty ?? def.minQty ?? 0, def.minQty ?? 0, def.maxQty ?? 0);
      }
    });

    return result;
  }

  function bindEvents() {
    bindCardEvents(el.flight, "flightId");
    bindCardEvents(el.roomConfig, "roomConfigId");
    bindCardEvents(el.stayA, "stayAId");
    bindCardEvents(el.stayB, "stayBId");
    bindCardEvents(el.meal, "mealLevelId");
    bindCardEvents(el.transport, "transportId");

    if (el.activityControls) {
      el.activityControls.addEventListener("click", (event) => {
        const qtyBtn = event.target.closest("button[data-activity-key][data-qty]");
        if (qtyBtn) {
          const key = qtyBtn.dataset.activityKey;
          const def = options.activities[key];
          if (!def || isBooleanActivity(def)) return;
          state.activities[key] = clampQty(
            Number(qtyBtn.dataset.qty),
            def.minQty ?? 0,
            def.maxQty ?? Number(qtyBtn.dataset.qty)
          );
          state.activityPackId = null;
          render();
          return;
        }

        const toggleBtn = event.target.closest("button[data-activity-toggle]");
        if (toggleBtn) {
          const key = toggleBtn.dataset.activityToggle;
          const def = options.activities[key];
          if (!def || !isBooleanActivity(def)) return;
          state.activities[key] = !state.activities[key];
          state.activityPackId = null;
          render();
        }
      });
    }

    if (el.activityPackOptions) {
      el.activityPackOptions.addEventListener("click", (event) => {
        const btn = event.target.closest("button[data-pack-id]");
        if (!btn) return;
        const pack = findById(options.activityPacks, btn.dataset.packId, { required: false });
        if (!pack) return;
        applyActivityPack(pack);
      });
    }

    el.categories.forEach((categoryEl) => {
      const section = categoryEl.dataset.section;
      const btn = categoryEl.querySelector(".category-toggle");
      if (!btn || !section) return;
      btn.addEventListener("click", () => {
        state.ui.accordion[section] = !state.ui.accordion[section];
        renderAccordion();
      });
    });

    if (el.openEvidence) {
      el.openEvidence.addEventListener("click", () => {
        el.evidenceModal.classList.remove("hidden");
      });
    }

    if (el.closeEvidence) {
      el.closeEvidence.addEventListener("click", () => {
        el.evidenceModal.classList.add("hidden");
      });
    }

    if (el.evidenceModal) {
      el.evidenceModal.addEventListener("click", (event) => {
        if (event.target === el.evidenceModal) {
          el.evidenceModal.classList.add("hidden");
        }
      });
    }

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && el.evidenceModal && !el.evidenceModal.classList.contains("hidden")) {
        el.evidenceModal.classList.add("hidden");
      }
    });
  }

  function bindCardEvents(container, stateKey) {
    if (!container) return;
    container.addEventListener("click", (event) => {
      const btn = event.target.closest("button[data-id]");
      if (!btn) return;
      state[stateKey] = btn.dataset.id;
      render();
    });
  }

  function applyActivityPack(pack) {
    const defs = options.activities || {};
    const apply = pack.apply || {};

    Object.entries(apply).forEach(([key, value]) => {
      const def = defs[key];
      if (!def) return;

      if (isBooleanActivity(def)) {
        state.activities[key] = Boolean(value);
      } else {
        state.activities[key] = clampQty(Number(value), def.minQty ?? 0, def.maxQty ?? Number(value));
      }
    });

    state.activityPackId = pack.id;
    render();
  }

  function render() {
    renderCardGroup(el.flight, options.flight, state.flightId);
    renderCardGroup(el.roomConfig, options.roomConfig, state.roomConfigId);
    renderCardGroup(el.stayA, options.stayA_3nights, state.stayAId);
    renderCardGroup(el.stayB, options.stayB_2nights, state.stayBId);
    renderCardGroup(el.meal, options.mealLevel, state.mealLevelId);
    renderCardGroup(el.transport, options.transport, state.transportId);

    renderActivityControls();
    renderActivityPacks();
    renderSelectionSummary();
    renderAccordion();

    const result = compute();
    renderResult(result);
    renderTimeline();
  }

  function renderCardGroup(container, list, selectedId) {
    if (!container) return;

    const normalized = Array.isArray(list) ? list : [];
    if (!normalized.length) {
      container.innerHTML = `<p class="empty-hint">선택 항목 없음</p>`;
      return;
    }

    container.innerHTML = normalized
      .map((item) => {
        const activeClass = item.id === selectedId ? "active" : "";
        const subtitle = item.subtitle ? `<span class="sub">${escapeHtml(item.subtitle)}</span>` : "";
        return `
          <button type="button" class="card-btn ${activeClass}" data-id="${escapeHtml(item.id)}" aria-pressed="${item.id === selectedId}">
            <span class="title">${escapeHtml(item.title)}</span>
            ${subtitle}
          </button>
        `;
      })
      .join("");
  }

  function renderActivityControls() {
    if (!el.activityControls) return;

    const defs = options.activities || {};
    const rows = Object.entries(defs).map(([key, def]) => {
      const label = escapeHtml(def.title || key);

      if (isBooleanActivity(def)) {
        const active = Boolean(state.activities[key]);
        return `
          <div class="activity-row">
            <span>${label}</span>
            <button
              type="button"
              class="toggle-btn ${active ? "active" : ""}"
              data-activity-toggle="${escapeHtml(key)}"
              aria-pressed="${active}"
            >${active ? "ON" : "OFF"}</button>
          </div>
        `;
      }

      const minQty = Number(def.minQty ?? 0);
      const maxQty = Number(def.maxQty ?? minQty);
      const selectedQty = Number(state.activities[key] ?? minQty);
      const qtyButtons = [];

      for (let qty = minQty; qty <= maxQty; qty += 1) {
        qtyButtons.push(`
          <button
            type="button"
            class="qty-btn ${qty === selectedQty ? "active" : ""}"
            data-activity-key="${escapeHtml(key)}"
            data-qty="${qty}"
            aria-pressed="${qty === selectedQty}"
          >${qty}</button>
        `);
      }

      return `
        <div class="activity-row">
          <span>${label}</span>
          <div class="qty-group" role="group" aria-label="${label}">${qtyButtons.join("")}</div>
        </div>
      `;
    });

    el.activityControls.innerHTML = rows.join("");
  }

  function renderActivityPacks() {
    if (!el.activityPackOptions) return;

    const packs = Array.isArray(options.activityPacks) ? options.activityPacks : [];
    if (!packs.length) {
      el.activityPackOptions.innerHTML = `<p class="empty-hint">팩 데이터 없음</p>`;
      return;
    }

    el.activityPackOptions.innerHTML = packs
      .map((pack) => {
        const active = state.activityPackId === pack.id;
        const subtitle = pack.subtitle ? `<span class="sub">${escapeHtml(pack.subtitle)}</span>` : "";
        return `
          <button type="button" class="card-btn ${active ? "active" : ""}" data-pack-id="${escapeHtml(pack.id)}" aria-pressed="${active}">
            <span class="title">${escapeHtml(pack.title)}</span>
            ${subtitle}
          </button>
        `;
      })
      .join("");
  }

  function renderSelectionSummary() {
    if (el.summaryFlight) el.summaryFlight.textContent = getTitle(options.flight, state.flightId);
    if (el.summaryRoomConfig) el.summaryRoomConfig.textContent = getTitle(options.roomConfig, state.roomConfigId);
    if (el.summaryStayA) el.summaryStayA.textContent = getTitle(options.stayA_3nights, state.stayAId);
    if (el.summaryStayB) el.summaryStayB.textContent = getTitle(options.stayB_2nights, state.stayBId);
    if (el.summaryMeal) el.summaryMeal.textContent = getTitle(options.mealLevel, state.mealLevelId);
    if (el.summaryTransport) el.summaryTransport.textContent = getTitle(options.transport, state.transportId);

    if (el.summaryActivities) {
      const activeItems = getActiveActivitySummaryItems();
      if (!activeItems.length) {
        el.summaryActivities.textContent = "없음";
      } else if (activeItems.length <= 2) {
        el.summaryActivities.textContent = activeItems.join(" · ");
      } else {
        el.summaryActivities.textContent = `${activeItems[0]} · ${activeItems[1]} 외 ${activeItems.length - 2}`;
      }
    }

    if (el.summaryActivityPack) {
      el.summaryActivityPack.textContent =
        state.activityPackId ? getTitle(options.activityPacks, state.activityPackId) : "직접 선택";
    }
  }

  function getActiveActivitySummaryItems() {
    const items = [];
    const defs = options.activities || {};

    Object.entries(defs).forEach(([key, def]) => {
      const value = state.activities[key];
      const shortName = (def.title || key).replace(/\(.+?\)/g, "").trim();

      if (isBooleanActivity(def)) {
        if (value) items.push(`${shortName} ON`);
        return;
      }

      const qty = Number(value || 0);
      if (qty > 0) items.push(`${shortName} x${qty}`);
    });

    return items;
  }

  function renderAccordion() {
    el.categories.forEach((categoryEl) => {
      const section = categoryEl.dataset.section;
      const expanded = state.ui.accordion[section] !== false;
      const btn = categoryEl.querySelector(".category-toggle");

      categoryEl.classList.toggle("is-open", expanded);
      if (btn) btn.setAttribute("aria-expanded", String(expanded));
    });
  }

  function compute() {
    const flight = findById(options.flight, state.flightId);
    const stayA = findById(options.stayA_3nights, state.stayAId);
    const stayB = findById(options.stayB_2nights, state.stayBId);
    const meal = findById(options.mealLevel, state.mealLevelId);
    const transport = findById(options.transport, state.transportId);

    const nightsA = Number(calculationRules.stayANights ?? 3);
    const nightsB = Number(calculationRules.stayBNights ?? 2);
    const roomCount = getEffectiveRoomCount();

    const flightBase = multiplyRange(flight.price, totalPeople);
    const stayABase = multiplyRange(stayA.price, roomCount * nightsA);
    const stayBBase = multiplyRange(stayB.price, roomCount * nightsB);
    const stayBase = sumRanges(stayABase, stayBBase);
    const mealBase = multiplyRange(meal.price, totalPeople * Number(calculationRules.mealChargeDays ?? 0));
    const transportBase = multiplyRange(transport.price, Number(calculationRules.transportChargeDays ?? 0));
    const activitiesBase = computeActivitiesCost();

    const flightCost = applyTaxByCategory("flight", flightBase);
    const stayCost = applyTaxByCategory("stay", stayBase);
    const mealCost = applyTaxByCategory("meal", mealBase);
    const transportCost = applyTaxByCategory("transport", transportBase);
    const activitiesCost = applyTaxByCategory("activities", activitiesBase);

    const subtotal = sumRanges(flightCost, stayCost, mealCost, transportCost, activitiesCost);
    const contingency = {
      minKRW: subtotal.minKRW * Number(calculationRules.contingencyRate?.min ?? 0),
      maxKRW: subtotal.maxKRW * Number(calculationRules.contingencyRate?.max ?? 0),
    };
    const total = sumRanges(subtotal, contingency);
    const perPerson = {
      minKRW: Math.floor(total.minKRW / totalPeople),
      maxKRW: Math.ceil(total.maxKRW / totalPeople),
    };

    validateRange("flight", flightCost);
    validateRange("stay", stayCost);
    validateRange("meal", mealCost);
    validateRange("transport", transportCost);
    validateRange("activities", activitiesCost);
    validateRange("contingency", contingency);
    validateRange("total", total);
    validateRange("perPerson", perPerson);

    return {
      perPerson,
      breakdown: {
        flight: flightCost,
        stay: stayCost,
        meal: mealCost,
        transport: transportCost,
        activities: activitiesCost,
        contingency,
      },
    };
  }

  function computeActivitiesCost() {
    const defs = options.activities || {};
    let activityCost = { minKRW: 0, maxKRW: 0 };

    Object.entries(defs).forEach(([key, def]) => {
      if (!def || !def.price) return;

      const selectedValue = state.activities[key];
      const qty = isBooleanActivity(def) ? (selectedValue ? 1 : 0) : Number(selectedValue || 0);
      if (qty <= 0) return;

      let factor = 0;
      if (key === "banaHill") {
        factor = getBanaHillPeopleFactor() * qty;
      } else if (def.unit === "perGroupPerUnit") {
        factor = qty;
      } else if (def.unit === "perPersonPerUnit") {
        factor = qty * totalPeople;
      } else {
        console.warn(`[unit-warning] Unsupported activity unit: ${def.unit} (${key})`);
        return;
      }

      activityCost = sumRanges(activityCost, multiplyRange(def.price, factor));
    });

    return activityCost;
  }

  function applyTaxByCategory(categoryKey, range) {
    const taxMap = calculationRules.taxIncluded || {};
    const isIncluded = taxMap[categoryKey];
    const taxRate = Number(calculationRules.taxRate ?? 0);

    if (isIncluded !== false || taxRate <= 0) {
      return range;
    }

    return multiplyRange(range, 1 + taxRate);
  }

  function getEffectiveRoomCount() {
    const defaultRoomCount = Number(calculationRules.roomCount ?? 0);
    const selectedConfig = findById(options.roomConfig, state.roomConfigId, { required: false });
    const overrideRoomCount = Number(selectedConfig?.overrides?.roomCount);

    if (Number.isFinite(overrideRoomCount) && overrideRoomCount > 0) {
      return overrideRoomCount;
    }

    return defaultRoomCount > 0 ? defaultRoomCount : 3;
  }

  function getBanaHillPeopleFactor() {
    const adults = Number(partyDefaults.adults ?? 0);
    const children = Number(partyDefaults.children ?? 0);

    if (!calculationRules.applyChildRuleForBanaHill) {
      return adults + children;
    }

    const childMultiplier = Number(fareRules?.activities?.banaHill?.childPriceVsAdult ?? 0.8);
    return adults + children * childMultiplier;
  }

  function renderResult(result) {
    if (el.perPersonTotal) {
      el.perPersonTotal.textContent = `${formatRange(result.perPerson)} / 1인`;
    }

    const rows = [
      ["항공", result.breakdown.flight],
      ["숙박", result.breakdown.stay],
      ["식비", result.breakdown.meal],
      ["이동", result.breakdown.transport],
      ["액티비티", result.breakdown.activities],
      ["예비비", result.breakdown.contingency],
    ];

    if (el.breakdown) {
      el.breakdown.innerHTML = rows
        .map(([label, range]) => `<li><span>${label}</span><strong>${formatRange(range)}</strong></li>`)
        .join("");
    }
  }

  function renderTimeline() {
    const items = [
      { day: "Day1", lines: ["도착/리조트"] },
      { day: "Day2", lines: ["리조트"] },
      { day: "Day3", lines: ["리조트 + 해산물"] },
      { day: "Day4", lines: ["호이안 이동 + 야시장"] },
      { day: "Day5", lines: ["호이안(카페/산책)"] },
      { day: "Day6", lines: ["귀국"] },
    ];

    if (state.activities.banaHill) {
      items[4].lines.push("바나힐");
    }

    if ((state.activities.massageSessions || 0) > 0) {
      items[1].lines.push("저녁 마사지");
      if ((state.activities.massageSessions || 0) > 1) {
        items[2].lines.push("저녁 마사지");
      }
    }

    if ((state.activities.seafoodDinner || 0) > 0) {
      items[2].lines.push(`해산물 디너 x${state.activities.seafoodDinner}`);
    }

    if ((state.activities.basketBoat || 0) > 0) {
      items[3].lines.push("바구니보트");
    }

    if ((state.activities.cafeDessert || 0) > 0) {
      items[4].lines.push(`카페/디저트 x${state.activities.cafeDessert}`);
    }

    if ((state.activities.indoorPlanB || 0) > 0) {
      items[1].lines.push(`실내 플랜B x${state.activities.indoorPlanB}`);
    }

    if (el.timeline) {
      el.timeline.innerHTML = items
        .map((item) => `<li><strong>${item.day}</strong> - ${item.lines.join(", ")}</li>`)
        .join("");
    }
  }

  function renderEvidence() {
    const sources = collectSources();

    if (el.evidenceAsOf) {
      el.evidenceAsOf.textContent = data.meta.asOf;
    }

    if (el.evidenceSources) {
      el.evidenceSources.innerHTML = sources
        .map((source) => {
          const noteText = source.note ? `<div>${escapeHtml(source.note)}</div>` : "";
          return `
            <li>
              <div><strong>${escapeHtml(source.sourceName)}</strong></div>
              <div><a href="${escapeHtml(source.sourceUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(source.sourceUrl)}</a></div>
              ${noteText}
            </li>
          `;
        })
        .join("");
    }
  }

  function collectSources() {
    const gathered = [];
    const pushSource = (item) => {
      if (item && item.sourceRef && item.sourceRef.sourceName && item.sourceRef.sourceUrl) {
        gathered.push(item.sourceRef);
      }
    };

    (options.flight || []).forEach(pushSource);
    (options.roomConfig || []).forEach(pushSource);
    (options.stayA_3nights || []).forEach(pushSource);
    (options.stayB_2nights || []).forEach(pushSource);
    (options.mealLevel || []).forEach(pushSource);
    (options.transport || []).forEach(pushSource);
    Object.values(options.activities || {}).forEach(pushSource);
    (options.activityPacks || []).forEach(pushSource);

    const map = new Map();
    gathered.forEach((source) => {
      const key = `${source.sourceName}|${source.sourceUrl}`;
      if (!map.has(key)) map.set(key, source);
    });

    return Array.from(map.values());
  }

  function isBooleanActivity(def) {
    return Object.prototype.hasOwnProperty.call(def || {}, "defaultEnabled");
  }

  function getTitle(list, id) {
    const found = findById(list, id, { required: false });
    return found ? found.title : "-";
  }

  function findById(list, id, { required = true } = {}) {
    const normalized = Array.isArray(list) ? list : [];
    const item = normalized.find((entry) => entry.id === id);

    if (!item && required) {
      throw new Error(`Option not found: ${id}`);
    }

    return item || null;
  }

  function pickDefaultId(list, preferredId, { required = true } = {}) {
    const normalized = Array.isArray(list) ? list : [];

    if (!normalized.length) {
      if (required) {
        throw new Error("Option list is empty.");
      }
      return null;
    }

    if (preferredId && normalized.some((item) => item.id === preferredId)) {
      return preferredId;
    }

    return normalized[0].id;
  }

  function clampQty(value, min, max) {
    const parsed = Number(value);
    const safe = Number.isFinite(parsed) ? parsed : min;
    return Math.max(min, Math.min(max, safe));
  }

  function multiplyRange(range, factor) {
    return {
      minKRW: range.minKRW * factor,
      maxKRW: range.maxKRW * factor,
    };
  }

  function sumRanges(...ranges) {
    return ranges.reduce(
      (acc, range) => ({
        minKRW: acc.minKRW + range.minKRW,
        maxKRW: acc.maxKRW + range.maxKRW,
      }),
      { minKRW: 0, maxKRW: 0 }
    );
  }

  function validateRange(label, range) {
    if (range.minKRW > range.maxKRW) {
      console.error(`[range-error] ${label}: min > max`, range);
    }
  }

  function formatRange(range) {
    return `${formatManwon(range.minKRW)} - ${formatManwon(range.maxKRW)}`;
  }

  function formatManwon(value) {
    const inManwon = Math.round(value / 10000);
    return `${inManwon.toLocaleString("ko-KR")}만원`;
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }
})();
