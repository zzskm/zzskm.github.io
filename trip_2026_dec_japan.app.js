(() => {
  const data = window.JAPAN_TRIP_DATA;
  if (!data) {
    console.error("JAPAN_TRIP_DATA not found. Load data.js first.");
    return;
  }

  const STORAGE_KEY = "trip_2026_dec_japan.v2";
  const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];
  const { cities, cityOrder, calculationRules } = data;
  const BAND_Z = Number(calculationRules.bandZ || 1.2816);
  const QUOTE_FIELDS = [
    { field: "flight", label: "확정가 · 1인 왕복", placeholder: "예: 320,000" },
    { field: "stayA", label: "확정가 · 숙박 총액", placeholder: "예: 850,000" },
    { field: "stayB", label: "확정가 · 숙박 총액", placeholder: "예: 400,000" },
  ];

  const el = {
    city: byId("city-options"),
    party: byId("party-controls"),
    duration: byId("duration-options"),
    season: byId("season-options"),
    fx: byId("fx-options"),
    flight: byId("flight-options"),
    airport: byId("airport-options"),
    roomConfig: byId("roomConfig-options"),
    stayA: byId("stayA-options"),
    stayB: byId("stayB-options"),
    meal: byId("meal-options"),
    transport: byId("transport-options"),
    activityControls: byId("activity-controls"),
    activityPacks: byId("activityPack-options"),
    titleStayA: byId("title-stayA"),
    titleActivities: byId("title-activities"),
    resultContext: byId("result-context"),
    perPersonTotal: byId("per-person-total"),
    perPersonBand: byId("per-person-band"),
    groupTotal: byId("group-total"),
    compareBody: byId("compare-body"),
    breakdown: byId("breakdown-list"),
    timeline: byId("timeline-list"),
    timelineWarning: byId("timeline-warning"),
    checkLinks: byId("check-links"),
    notes: byId("note-list"),
    openEvidence: byId("open-evidence"),
    closeEvidence: byId("close-evidence"),
    resetState: byId("reset-state"),
    evidenceModal: byId("evidence-modal"),
    evidenceAsOf: byId("evidence-asof"),
    evidenceSources: byId("evidence-sources"),
    categories: Array.from(document.querySelectorAll(".category[data-section]")),
  };

  const state = loadState() || createInitialState();
  state.ui = { accordion: createInitialAccordionState() };

  bindEvents();
  render();
  renderEvidence();

  // ---------- State ----------
  function createInitialState() {
    const perCity = {};
    cityOrder.forEach((cityId) => {
      perCity[cityId] = createCityState(cityId);
    });

    return {
      cityId: cityOrder[0],
      travelers: data.party.travelers.defaultValue,
      durationId: "n4",
      seasonId: data.seasons[0].id,
      fxId: data.fxOptions[0].id,
      cities: perCity,
    };
  }

  function createCityState(cityId) {
    const city = cities[cityId];
    const d = city.defaults || {};
    const flightId = pickId(city.flights, d.flightId);
    const flight = findById(city.flights, flightId);

    return {
      flightId,
      airportId: pickId(airportOptionsFor(city, flight), d.airportId),
      roomConfigId: pickId(data.roomConfigs, d.roomConfigId),
      stayAId: pickId(city.staysA, d.stayAId),
      stayBId: pickId(city.staysB, d.stayBId),
      mealId: pickId(data.mealLevels, d.mealId),
      transportId: pickId(city.transports, d.transportId),
      packId: null,
      activities: createActivitiesState(city, d.activities),
      quotes: {},
    };
  }

  function sanitizeQuotes(raw) {
    const result = {};
    if (!raw || typeof raw !== "object") return result;
    QUOTE_FIELDS.forEach(({ field }) => {
      const quote = raw[field];
      const krw = Number(quote && quote.krw);
      if (!quote || typeof quote.key !== "string" || !Number.isFinite(krw) || krw <= 0) return;
      result[field] = { krw: Math.round(krw), key: quote.key, context: typeof quote.context === "string" ? quote.context : "" };
    });
    return result;
  }

  function createActivitiesState(city, preset) {
    const result = {};
    city.activities.forEach((act) => {
      const presetValue = preset ? preset[act.id] : undefined;
      if (act.kind === "toggle") {
        result[act.id] = Boolean(presetValue !== undefined ? presetValue : act.defaultOn);
      } else {
        result[act.id] = clamp(presetValue ?? act.min ?? 0, act.min ?? 0, act.max ?? 0);
      }
    });
    return result;
  }

  function loadState() {
    let raw = null;
    try {
      raw = window.localStorage.getItem(STORAGE_KEY);
    } catch (error) {
      return null;
    }
    if (!raw) return null;

    try {
      const saved = JSON.parse(raw);
      const base = createInitialState();
      const next = {
        cityId: cities[saved.cityId] ? saved.cityId : base.cityId,
        travelers: clamp(saved.travelers ?? base.travelers, data.party.travelers.min, data.party.travelers.max),
        durationId: pickId(data.durations, saved.durationId),
        seasonId: pickId(data.seasons, saved.seasonId),
        fxId: pickId(data.fxOptions, saved.fxId),
        cities: {},
      };

      cityOrder.forEach((cityId) => {
        const city = cities[cityId];
        const savedCity = (saved.cities && saved.cities[cityId]) || {};
        const fallback = base.cities[cityId];
        const flightId = pickId(city.flights, savedCity.flightId || fallback.flightId);
        const flight = findById(city.flights, flightId);
        const activities = { ...fallback.activities };
        city.activities.forEach((act) => {
          const value = savedCity.activities ? savedCity.activities[act.id] : undefined;
          if (value === undefined) return;
          activities[act.id] = act.kind === "toggle" ? Boolean(value) : clamp(value, act.min ?? 0, act.max ?? 0);
        });

        next.cities[cityId] = {
          flightId,
          airportId: pickId(airportOptionsFor(city, flight), savedCity.airportId || fallback.airportId),
          roomConfigId: pickId(data.roomConfigs, savedCity.roomConfigId || fallback.roomConfigId),
          stayAId: pickId(city.staysA, savedCity.stayAId || fallback.stayAId),
          stayBId: pickId(city.staysB, savedCity.stayBId || fallback.stayBId),
          mealId: pickId(data.mealLevels, savedCity.mealId || fallback.mealId),
          transportId: pickId(city.transports, savedCity.transportId || fallback.transportId),
          packId: findById(city.packs, savedCity.packId) ? savedCity.packId : null,
          activities,
          quotes: sanitizeQuotes(savedCity.quotes),
        };
      });

      return next;
    } catch (error) {
      console.warn("[state] saved selection ignored", error);
      return null;
    }
  }

  function saveState() {
    const { ui, ...rest } = state;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(rest));
    } catch (error) {
      // Storage can be unavailable (private mode, blocked site data); the page works without it.
    }
  }

  function createInitialAccordionState() {
    const mobile = window.matchMedia("(max-width: 768px)").matches;
    const sections = ["city", "party", "schedule", "fx", "flight", "airport", "roomConfig", "stayA", "stayB", "meal", "transport", "activities", "activityPacks"];
    const openOnMobile = new Set(["city", "party", "schedule", "activities"]);
    const result = {};
    sections.forEach((section) => {
      result[section] = mobile ? openOnMobile.has(section) : true;
    });
    return result;
  }

  function cityState(cityId = state.cityId) {
    return state.cities[cityId];
  }

  // ---------- Events ----------
  function bindEvents() {
    onCardClick(el.city, (id) => {
      if (cities[id]) state.cityId = id;
    });
    onCardClick(el.duration, (id) => {
      state.durationId = id;
    });
    onCardClick(el.season, (id) => {
      state.seasonId = id;
    });
    onCardClick(el.fx, (id) => {
      state.fxId = id;
    });
    onCardClick(el.flight, (id) => {
      const city = cities[state.cityId];
      const s = cityState();
      s.flightId = id;
      const options = airportOptionsFor(city, findById(city.flights, id));
      if (!findById(options, s.airportId)) s.airportId = options[0].id;
    });
    onCardClick(el.airport, (id) => {
      cityState().airportId = id;
    });
    onCardClick(el.roomConfig, (id) => {
      cityState().roomConfigId = id;
    });
    onCardClick(el.stayA, (id) => {
      cityState().stayAId = id;
    });
    onCardClick(el.stayB, (id) => {
      cityState().stayBId = id;
    });
    onCardClick(el.meal, (id) => {
      cityState().mealId = id;
    });
    onCardClick(el.transport, (id) => {
      cityState().transportId = id;
    });

    el.party.addEventListener("click", (event) => {
      const btn = event.target.closest("button[data-qty]");
      if (!btn) return;
      const rule = data.party.travelers;
      state.travelers = clamp(Number(btn.dataset.qty), rule.min, rule.max);
      commit();
    });

    el.activityControls.addEventListener("click", (event) => {
      const city = cities[state.cityId];
      const s = cityState();
      const qtyBtn = event.target.closest("button[data-activity][data-qty]");
      const toggleBtn = event.target.closest("button[data-activity-toggle]");

      if (qtyBtn) {
        const act = findById(city.activities, qtyBtn.dataset.activity);
        if (!act || act.kind === "toggle") return;
        s.activities[act.id] = clamp(Number(qtyBtn.dataset.qty), act.min ?? 0, act.max ?? 0);
      } else if (toggleBtn) {
        const act = findById(city.activities, toggleBtn.dataset.activityToggle);
        if (!act || act.kind !== "toggle") return;
        s.activities[act.id] = !s.activities[act.id];
      } else {
        return;
      }
      s.packId = null;
      commit();
    });

    el.activityPacks.addEventListener("click", (event) => {
      const btn = event.target.closest("button[data-id]");
      if (!btn) return;
      const city = cities[state.cityId];
      const pack = findById(city.packs, btn.dataset.id);
      if (!pack) return;
      const s = cityState();
      Object.entries(pack.apply || {}).forEach(([key, value]) => {
        const act = findById(city.activities, key);
        if (!act) return;
        s.activities[key] = act.kind === "toggle" ? Boolean(value) : clamp(Number(value), act.min ?? 0, act.max ?? 0);
      });
      s.packId = pack.id;
      commit();
    });

    // Quotes commit on change (Enter or leaving the field); the inputs are updated in place, so focus survives.
    el.checkLinks.addEventListener("change", (event) => {
      const input = event.target.closest("input[data-quote]");
      if (!input) return;
      const field = input.dataset.quote;
      const s = cityState();
      s.quotes = s.quotes || {};
      const krw = parseKRW(input.value);
      if (!krw) {
        delete s.quotes[field];
        input.value = "";
      } else {
        const r = compute(state.cityId);
        if (!r.quoteKeys[field]) return;
        s.quotes[field] = { krw, key: r.quoteKeys[field], context: r.quoteContext[field] };
        input.value = formatNumber(krw);
      }
      commit();
    });

    el.compareBody.addEventListener("click", (event) => {
      const btn = event.target.closest("button[data-city]");
      if (!btn || !cities[btn.dataset.city]) return;
      state.cityId = btn.dataset.city;
      commit();
    });

    el.categories.forEach((categoryEl) => {
      const section = categoryEl.dataset.section;
      const btn = categoryEl.querySelector(".category-toggle");
      if (!btn || !section) return;
      btn.addEventListener("click", () => {
        state.ui.accordion[section] = !state.ui.accordion[section];
        renderAccordion();
      });
    });

    el.openEvidence.addEventListener("click", () => {
      el.evidenceModal.classList.remove("hidden");
      el.closeEvidence.focus();
    });
    el.closeEvidence.addEventListener("click", closeEvidence);
    el.evidenceModal.addEventListener("click", (event) => {
      if (event.target === el.evidenceModal) closeEvidence();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !el.evidenceModal.classList.contains("hidden")) closeEvidence();
    });

    el.resetState.addEventListener("click", () => {
      const ui = state.ui;
      Object.assign(state, createInitialState(), { ui });
      commit();
    });
  }

  function closeEvidence() {
    el.evidenceModal.classList.add("hidden");
    el.openEvidence.focus();
  }

  function onCardClick(container, handler) {
    container.addEventListener("click", (event) => {
      const btn = event.target.closest("button[data-id]");
      if (!btn) return;
      handler(btn.dataset.id);
      commit();
    });
  }

  function commit() {
    saveState();
    render();
  }

  // ---------- Render ----------
  function render() {
    const city = cities[state.cityId];
    const s = cityState();
    const flight = findById(city.flights, s.flightId);
    const results = {};
    cityOrder.forEach((cityId) => {
      results[cityId] = compute(cityId);
    });
    const result = results[state.cityId];

    renderCityCards(results);
    renderParty();
    renderCards(el.duration, data.durations, state.durationId);
    renderCards(el.season, data.seasons, state.seasonId);
    renderCards(el.fx, data.fxOptions, state.fxId);
    renderCards(el.flight, city.flights, s.flightId, (item) => `${item.subtitle} · ${formatKRWRange(item.priceKRW)}`);
    renderCards(el.airport, airportOptionsFor(city, flight), s.airportId);
    renderCards(el.roomConfig, data.roomConfigs, s.roomConfigId, (item) => `${item.subtitle} · ${state.travelers}명 → ${roomCountFor(item, state.travelers)}실`);
    renderCards(el.stayA, city.staysA, s.stayAId, (item) => `${item.subtitle} · ${describeStayPrice(item)}`);
    renderCards(el.stayB, city.staysB, s.stayBId, (item) => (item.id === "none" ? item.subtitle : `${item.subtitle} · ${describeStayPrice(item)}`));
    renderCards(el.meal, data.mealLevels, s.mealId, (item) => `${item.subtitle} · 1인 ${formatJPYRange(item.perPersonPerDayJPY)}/일`);
    renderCards(el.transport, city.transports, s.transportId);
    renderActivityControls(city, s);
    renderCards(el.activityPacks, city.packs, s.packId);

    if (el.titleStayA) el.titleStayA.textContent = `A숙소 · ${city.name} (${result.nightsA}박)`;
    if (el.titleActivities) el.titleActivities.textContent = `액티비티 · ${city.name}`;

    renderSummaries(city, s, result);
    renderAccordion();
    renderResult(city, result);
    renderCompare(results);
    renderTimeline(city, s, result);
    renderCheckLinks(city, s, result);
    renderNotes(city, s, result);
  }

  function renderCityCards(results) {
    const cheapest = cheapestCityId(results);
    el.city.innerHTML = cityOrder
      .map((cityId) => {
        const city = cities[cityId];
        const r = results[cityId];
        const active = cityId === state.cityId;
        const badge = cityId === cheapest ? `<span class="badge">최저</span>` : "";
        return `
          <button type="button" class="card-btn city-card ${active ? "active" : ""}" data-id="${esc(cityId)}" aria-pressed="${active}">
            <span class="title">${esc(city.name)} ${badge}</span>
            <span class="sub">${esc(city.subtitle)} · ${esc(city.flightTime)}</span>
            <span class="price">약 ${formatManwon(r.perPerson.mean)} <small>${formatBand(r.perPerson.band)} / 1인</small></span>
          </button>
        `;
      })
      .join("");
  }

  function renderParty() {
    const rule = data.party.travelers;
    const buttons = [];
    for (let qty = rule.min; qty <= rule.max; qty += 1) {
      const active = qty === state.travelers;
      buttons.push(
        `<button type="button" class="qty-btn ${active ? "active" : ""}" data-qty="${qty}" aria-pressed="${active}">${qty}</button>`
      );
    }
    el.party.innerHTML = `
      <div class="activity-row">
        <span>인원 (명)</span>
        <div class="qty-group" role="group" aria-label="여행 인원">${buttons.join("")}</div>
      </div>
      <p class="field-note">${esc(data.party.note)}</p>
    `;
  }

  function renderCards(container, list, selectedId, subtitleFn) {
    const items = Array.isArray(list) ? list : [];
    if (!items.length) {
      container.innerHTML = `<p class="empty-hint">선택 항목 없음</p>`;
      return;
    }
    container.innerHTML = items
      .map((item) => {
        const active = item.id === selectedId;
        const subtitleText = subtitleFn ? subtitleFn(item) : item.subtitle;
        const subtitle = subtitleText ? `<span class="sub">${esc(subtitleText)}</span>` : "";
        return `
          <button type="button" class="card-btn ${active ? "active" : ""}" data-id="${esc(item.id)}" aria-pressed="${active}">
            <span class="title">${esc(item.title)}</span>
            ${subtitle}
          </button>
        `;
      })
      .join("");
  }

  function renderActivityControls(city, s) {
    const season = currentSeason();
    el.activityControls.innerHTML = city.activities
      .map((act) => {
        const priceText = describeActivityPrice(act, season);
        const label = `<span class="activity-label">${esc(act.title)}<small>${esc(priceText)}</small></span>`;

        if (act.kind === "toggle") {
          const on = Boolean(s.activities[act.id]);
          const disabledNote = act.perUnitOf && !Number(s.activities[act.perUnitOf] || 0) ? " (USJ 0일)" : "";
          return `
            <div class="activity-row">
              ${label}
              <button type="button" class="toggle-btn ${on ? "active" : ""}" data-activity-toggle="${esc(act.id)}" aria-pressed="${on}">${on ? "ON" : "OFF"}${disabledNote}</button>
            </div>
          `;
        }

        const selected = Number(s.activities[act.id] || 0);
        const buttons = [];
        for (let qty = act.min ?? 0; qty <= (act.max ?? 0); qty += 1) {
          const active = qty === selected;
          buttons.push(
            `<button type="button" class="qty-btn ${active ? "active" : ""}" data-activity="${esc(act.id)}" data-qty="${qty}" aria-pressed="${active}">${qty}</button>`
          );
        }
        return `
          <div class="activity-row">
            ${label}
            <div class="qty-group" role="group" aria-label="${esc(act.title)}">${buttons.join("")}</div>
          </div>
        `;
      })
      .join("");
  }

  function renderSummaries(city, s, result) {
    const set = (id, text) => {
      const node = byId(id);
      if (node) node.textContent = text;
    };
    set("summary-city", `${city.name} · 약 ${formatManwon(result.perPerson.mean)}`);
    set("summary-party", `${result.people}명`);
    set("summary-schedule", `${currentDuration().title} · ${currentSeason().title}`);
    set("summary-fx", currentFx().title);
    set("summary-flight", titleOf(city.flights, s.flightId));
    set("summary-airport", titleOf(airportOptionsFor(city, findById(city.flights, s.flightId)), s.airportId));
    set("summary-roomConfig", result.roomSummary);
    set("summary-stayA", titleOf(city.staysA, s.stayAId));
    set("summary-stayB", titleOf(city.staysB, s.stayBId));
    set("summary-meal", titleOf(data.mealLevels, s.mealId));
    set("summary-transport", titleOf(city.transports, s.transportId));
    set("summary-activityPack", s.packId ? titleOf(city.packs, s.packId) : "직접 선택");

    const activeItems = city.activities
      .map((act) => {
        const value = s.activities[act.id];
        const shortName = act.title.replace(/\(.+?\)/g, "").trim();
        if (act.kind === "toggle") return value ? shortName : null;
        return Number(value) > 0 ? `${shortName} x${value}` : null;
      })
      .filter(Boolean);
    set(
      "summary-activities",
      !activeItems.length ? "없음" : activeItems.length <= 2 ? activeItems.join(" · ") : `${activeItems[0]} · ${activeItems[1]} 외 ${activeItems.length - 2}`
    );
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

  function renderResult(city, result) {
    const dates = `${formatDate(result.startDate)}–${formatDate(addDays(result.startDate, result.nights))}`;
    el.resultContext.textContent = `${city.name} · ${currentDuration().title} · ${dates}`;
    const pp = result.perPerson;
    el.perPersonTotal.textContent = `약 ${formatManwon(pp.mean)} / 1인`;
    el.perPersonBand.innerHTML = `80% 범위 ${esc(formatBand(pp.band))}<span class="band-extreme"> · 항목 단순 합산 ${esc(formatBand(pp.extreme))}</span>`;
    el.groupTotal.textContent = `총액 약 ${formatManwon(result.total.mean)} (${formatBand(result.total.band)}) · ${result.people}명 · ${currentFx().title}`;

    const b = result.breakdown;
    const rows = [
      ["항공", b.flight, result.flightNote],
      ["숙박", b.stay, result.stayNote],
      ["숙박세·입탕세", b.stayTax, "1인 1박 기준, 현장 결제"],
      ["식비", b.meal, `${result.mealDays}일 기준`],
      ["공항 이동", b.airport, titleOf(airportOptionsFor(city, findById(city.flights, cityState().flightId)), cityState().airportId)],
      ["시내 교통", b.transport, titleOf(city.transports, cityState().transportId)],
      ["근교 이동", b.excursion, result.stayB ? `${result.stayB.short || result.stayB.title} 왕복` : ""],
      ["액티비티", b.activities, ""],
      ["예비비", b.contingency, `예상 합계의 ${pct(calculationRules.contingencyRate)} · 범위에 영향 없음`],
    ].filter(([label, line]) => label !== "근교 이동" || line.hi > 0);

    el.breakdown.innerHTML = rows
      .map(([label, line, note]) => {
        const detail = lineDetail(line);
        return `
          <li>
            <span>${esc(label)}${note ? `<small>${esc(note)}</small>` : ""}</span>
            <strong>${formatManwon(line.mean)}${detail ? `<small class="${line.locked ? "is-locked" : ""}">${esc(detail)}</small>` : ""}</strong>
          </li>
        `;
      })
      .join("");
  }

  function lineDetail(line) {
    if (line.locked) return "확정가";
    const prefix = line.partial ? "일부 확정 · " : "";
    if (Math.round(line.lo / 10000) === Math.round(line.hi / 10000)) return line.partial ? "일부 확정" : "";
    return `${prefix}${formatBand([line.lo, line.hi])}`;
  }

  function renderCompare(results) {
    const cheapest = cheapestCityId(results);
    el.compareBody.innerHTML = cityOrder
      .map((cityId) => {
        const city = cities[cityId];
        const r = results[cityId];
        const s = state.cities[cityId];
        const active = cityId === state.cityId;
        const picks = [
          titleOf(city.flights, s.flightId).split(" · ")[0],
          shortTitle(titleOf(city.staysA, s.stayAId)),
          r.fullDayLabels.length ? r.fullDayLabels.join(" + ") : "자유일정",
        ].join(" · ");
        return `
          <tr class="${active ? "is-active" : ""}">
            <th scope="row">
              <button type="button" class="link-btn" data-city="${esc(cityId)}" aria-pressed="${active}">${esc(city.name)}</button>
              ${cityId === cheapest ? `<span class="badge">최저</span>` : ""}
              <small>${esc(picks)}</small>
            </th>
            <td><strong>${formatManwon(r.perPerson.mean)}</strong><small>${formatBand(r.perPerson.band)}</small></td>
            <td>${formatManwon(r.total.mean)}<small>${formatBand(r.total.band)}</small></td>
          </tr>
        `;
      })
      .join("");
  }

  function renderTimeline(city, s, result) {
    const plan = buildTimeline(city, s, result);
    el.timeline.innerHTML = plan.days
      .map(
        (day, index) => `
          <li>
            <strong>Day${index + 1}</strong> <span class="day-date">${esc(formatDate(day.date))}</span>
            <span class="day-items">${day.items.map(esc).join(", ")}</span>
          </li>
        `
      )
      .join("");

    if (plan.overflow.length) {
      el.timelineWarning.hidden = false;
      el.timelineWarning.textContent = `일정 초과: ${plan.overflow.join(", ")} 은(는) 들어갈 날이 없습니다. 기간을 늘리거나 수량을 줄이세요.`;
    } else {
      el.timelineWarning.hidden = true;
      el.timelineWarning.textContent = "";
    }
  }

  // The three slots are built once and then updated in place, so a quote input keeps focus across renders.
  function ensureCheckLinkSlots() {
    if (el.checkLinks.dataset.ready) return;
    el.checkLinks.innerHTML = QUOTE_FIELDS.map(
      ({ field, label, placeholder }) => `
        <li data-link="${esc(field)}">
          <a href="#" target="_blank" rel="noopener noreferrer" data-role="link"></a>
          <small data-role="sub"></small>
          <div class="quote-row">
            <label for="quote-${esc(field)}">${esc(label)}</label>
            <input id="quote-${esc(field)}" class="quote-input" type="text" inputmode="numeric" autocomplete="off" data-quote="${esc(field)}" placeholder="${esc(placeholder)}" />
            <span class="quote-unit">원</span>
          </div>
          <small class="quote-status" data-role="status"></small>
        </li>
      `
    ).join("");
    el.checkLinks.dataset.ready = "1";
  }

  function renderCheckLinks(city, s, result) {
    ensureCheckLinkSlots();
    const flight = findById(city.flights, s.flightId);
    const start = result.startDate;
    const end = addDays(start, result.nights);
    const checkoutA = addDays(start, result.nightsA);
    const stayA = findById(city.staysA, s.stayAId);
    const roomConfig = findById(data.roomConfigs, s.roomConfigId);
    const roomType = (stay) => {
      if (stay.perUnitPerNightJPY) return "2룸(침실 2개)";
      if (stay.perPersonPerNightJPY) return `${roomConfig.occupancy}인 1실`;
      return roomConfig.occupancy === 2 ? "트윈(침대 2개)" : roomConfig.title;
    };
    const flightQuery = `Flights from ICN to ${flight.airport} on ${start} through ${end}`;

    const slots = {
      flight: {
        label: `항공권 · ICN→${flight.airport} ${formatDate(start)}–${formatDate(end)}`,
        sub: `Google Flights · ${flight.title}`,
        href: `https://www.google.com/travel/flights?hl=ko&curr=KRW&q=${encodeURIComponent(flightQuery)}`,
      },
      stayA: {
        label: `A숙소 · ${stayA.title} ${formatDate(start)}–${formatDate(checkoutA)}`,
        sub: `Booking.com · ${roomType(stayA)} ${result.roomsA}${stayA.perUnitPerNightJPY ? "채" : "실"}`,
        href: bookingUrl(stayA.booking || city.bookingCity, start, checkoutA, result.roomsA),
      },
      stayB: result.stayB
        ? {
            label: `B숙소 · ${result.stayB.title} ${formatDate(checkoutA)}–${formatDate(end)}`,
            sub: `Booking.com · ${roomType(result.stayB)} ${result.roomsB}${result.stayB.perUnitPerNightJPY ? "채" : "실"}`,
            href: bookingUrl(result.stayB.booking || city.bookingCity, checkoutA, end, result.roomsB),
          }
        : null,
    };

    QUOTE_FIELDS.forEach(({ field }) => {
      const li = el.checkLinks.querySelector(`[data-link="${field}"]`);
      const slot = slots[field];
      li.hidden = !slot;
      if (!slot) return;
      const link = li.querySelector('[data-role="link"]');
      link.href = slot.href;
      link.textContent = slot.label;
      li.querySelector('[data-role="sub"]').textContent = slot.sub;

      const quote = (s.quotes || {})[field];
      const input = li.querySelector("input[data-quote]");
      if (document.activeElement !== input) input.value = quote ? formatNumber(quote.krw) : "";

      const status = li.querySelector('[data-role="status"]');
      const { text, tone } = quoteStatusText(field, quote, result);
      status.textContent = text;
      status.className = `quote-status ${tone}`;
    });
  }

  function quoteStatusText(field, quote, result) {
    const estimate = result.estimates[field];
    const estimateText = field === "flight" ? `추정 1인 ${formatKRWRange(estimate)}` : `추정 ${formatBand(estimate)}`;
    const status = result.quoteStatus[field];
    if (status === "applied") {
      const applied = field === "flight" ? `${result.people}명 ${formatManwon(quote.krw * result.people)}` : formatManwon(quote.krw);
      return { text: `적용 중 · ${applied} (${estimateText})`, tone: "is-applied" };
    }
    if (status === "stale") {
      return { text: `조건이 바뀌어 미적용 · 입력 당시 ${quote.context || "다른 조건"} · ${estimateText}`, tone: "is-stale" };
    }
    const hint = field === "flight" ? "확인한 1인 왕복가를 넣으면 확정값으로 계산" : "세금 포함 총액(숙박세 제외)을 넣으면 확정값으로 계산";
    return { text: `${estimateText} · ${hint}`, tone: "" };
  }

  function renderNotes(city, s, result) {
    const notes = [...(currentSeason().notes || []), ...(city.notes || [])];
    const roomConfig = findById(data.roomConfigs, s.roomConfigId);
    notes.push(`숙박은 평일가에 1박마다 날짜 배율을 곱합니다 (이번 일정 ${result.nightFactorText}).`);
    if (result.usesUnits) {
      notes.push("2룸 레지던스는 객실 구성과 무관하게 4인당 1채(침실 2개, 침실마다 트윈)로 계산합니다. 침대 구성을 꼭 확인하세요.");
    }
    if (roomConfig.occupancy === 2 && !result.usesUnits) {
      notes.push("2인 1실은 트윈(침대 2개)으로 계산합니다. 객실 유형이 '트윈(ツイン)'인지 확인하세요. 더블·세미더블은 침대가 1개입니다.");
      notes.push("트윈이 없거나 마감이면 2룸(1인 1실 2개)으로 잡으세요. 비용은 '1인 1실' 카드로 비교할 수 있습니다.");
    }
    if (roomConfig.occupancy === 1) {
      notes.push("1인 1실은 트윈 요금의 70%로 계산합니다. 비즈니스호텔 싱글룸은 더 싸고, 료칸은 1인 이용 할증(×1.4)이 붙습니다.");
    } else if (state.travelers % roomConfig.occupancy !== 0) {
      notes.push(`${state.travelers}명은 ${roomConfig.title}로 나누어 떨어지지 않아 1실은 ${state.travelers % roomConfig.occupancy}명이 같은 요금으로 씁니다.`);
    }
    if (roomConfig.occupancy >= 3) {
      notes.push("트리플·쿼드룸은 보유 호텔이 적고 빨리 마감됩니다. 실시간 링크로 객실 유형을 먼저 확인하세요.");
    }
    const flight = findById(city.flights, s.flightId);
    if (flight.id.startsWith("lcc")) {
      notes.push("LCC 특가는 위탁 수하물이 빠진 운임이 많습니다. 15kg 포함 여부를 확인하세요.");
    }
    el.notes.innerHTML = notes.map((note) => `<li>${esc(note)}</li>`).join("");
  }

  function renderEvidence() {
    el.evidenceAsOf.textContent = data.meta.asOf;
    const groups = [{ title: "공통 (계산 방식·환율·숙박세·시기·객실·식비)", items: collectShared() }];
    cityOrder.forEach((cityId) => {
      groups.push({ title: cities[cityId].name, items: collectCitySources(cities[cityId]) });
    });

    el.evidenceSources.innerHTML = groups
      .map(
        (group) => `
          <li class="source-group">
            <h3>${esc(group.title)}</h3>
            <ul>
              ${dedupeSources(group.items)
                .map(
                  (source) => `
                    <li>
                      <div><strong>${esc(source.sourceName)}</strong></div>
                      <div><a href="${esc(source.sourceUrl)}" target="_blank" rel="noopener noreferrer">${esc(source.sourceUrl)}</a></div>
                      ${source.note ? `<div class="source-note">${esc(source.note)}</div>` : ""}
                    </li>
                  `
                )
                .join("")}
            </ul>
          </li>
        `
      )
      .join("");
  }

  function collectShared() {
    const items = [...(data.meta.sharedSources || [])];
    [calculationRules, data.lodgingCalendar || {}, ...data.seasons, ...data.roomConfigs, ...data.mealLevels].forEach((item) => {
      if (item.sourceRef) items.push(item.sourceRef);
    });
    return items;
  }

  function collectCitySources(city) {
    const items = [];
    [city.flights, city.airportTransfers, city.staysA, city.staysB, city.transports, city.activities].forEach((list) => {
      (list || []).forEach((item) => {
        if (item.sourceRef) items.push(item.sourceRef);
        if (item.sourceRef2) items.push(item.sourceRef2);
      });
    });
    return items;
  }

  function dedupeSources(items) {
    const map = new Map();
    items.forEach((source) => {
      if (!source || !source.sourceName || !source.sourceUrl) return;
      const key = `${source.sourceName}|${source.sourceUrl}`;
      if (!map.has(key)) map.set(key, source);
    });
    return Array.from(map.values());
  }

  // ---------- Compute ----------
  function compute(cityId) {
    const city = cities[cityId];
    const s = state.cities[cityId];
    const people = state.travelers;
    const nights = currentDuration().nights;
    const days = nights + 1;
    const season = currentSeason();
    const fx = currentFx().krwPer100Jpy / 100;
    const peak = season.parkTier === "peak";

    const flight = findById(city.flights, s.flightId);
    const airport = findById(airportOptionsFor(city, flight), s.airportId) || airportOptionsFor(city, flight)[0];
    const roomConfig = findById(data.roomConfigs, s.roomConfigId);
    const stayA = findById(city.staysA, s.stayAId);
    const stayBRaw = findById(city.staysB, s.stayBId);
    const stayB = stayBRaw && stayBRaw.id !== "none" ? stayBRaw : null;
    const meal = findById(data.mealLevels, s.mealId);
    const transport = findById(city.transports, s.transportId);

    const nightsA = nights - (stayB ? 1 : 0);
    const start = season.startDate;
    const end = addDays(start, nights);
    const checkoutA = addDays(start, nightsA);
    // Every line is an estimate {lo, hi, mean, var} in KRW; [lo, hi] is read as that line's P10-P90.
    const fromJPY = (r, factor = 1) => estimate(r, fx * factor);

    // Stays: weekday card price × each night's calendar factor
    const factorsA = nightFactors(start, nightsA);
    const factorsB = stayB ? nightFactors(checkoutA, 1) : [];
    const stayAInfo = stayCost(stayA, roomConfig, people, factorsA);
    const stayBInfo = stayB ? stayCost(stayB, roomConfig, people, factorsB) : emptyStay();

    // Quotes typed from the live links replace the estimate while their conditions still match.
    const roomsLabel = (info) => `${info.rooms}${info.usesUnits ? "채" : "실"}`;
    const quoteKeys = {
      flight: [flight.id, start, end].join("|"),
      stayA: [stayA.id, start, checkoutA, stayAInfo.kind, stayAInfo.rooms, people].join("|"),
      stayB: stayB ? [stayB.id, checkoutA, end, stayBInfo.kind, stayBInfo.rooms, people].join("|") : null,
    };
    const quoteContext = {
      flight: `${flight.title} ${formatDate(start)}–${formatDate(end)}`,
      stayA: `${shortTitle(stayA.title)} ${formatDate(start)}–${formatDate(checkoutA)} · ${people}명 ${roomsLabel(stayAInfo)}`,
      stayB: stayB ? `${shortTitle(stayB.title)} ${formatDate(checkoutA)}–${formatDate(end)} · ${people}명 ${roomsLabel(stayBInfo)}` : "",
    };
    const quotes = s.quotes || {};
    const quoteStatus = {};
    Object.keys(quoteKeys).forEach((field) => {
      const quote = quotes[field];
      quoteStatus[field] = !quote || !quoteKeys[field] ? "none" : quote.key === quoteKeys[field] ? "applied" : "stale";
    });
    const applied = (field) => quoteStatus[field] === "applied";

    const flightPerPerson = scale(flight.priceKRW, season.flightFactor);
    const estimates = {
      flight: flightPerPerson,
      stayA: scale(stayAInfo.cost, fx),
      stayB: stayB ? scale(stayBInfo.cost, fx) : null,
    };

    // Flight (KRW)
    const flightLine = applied("flight") ? exact(quotes.flight.krw * people, true) : estimate(flightPerPerson, people);

    // Stays
    const stayALine = applied("stayA") ? exact(quotes.stayA.krw, true) : estimate(estimates.stayA);
    const stayBLine = !stayB ? exact(0) : applied("stayB") ? exact(quotes.stayB.krw, true) : estimate(estimates.stayB);
    const stayLine = sumLines(stayALine, stayBLine);
    stayLine.locked = stayALine.locked && (!stayB || stayBLine.locked);
    stayLine.partial = !stayLine.locked && (stayALine.locked || stayBLine.locked);

    // Lodging / bathing tax (per person per night)
    const stayTaxLine = sumLines(
      fromJPY(stayA.lodgingTaxJPY || [0, 0], people * nightsA),
      stayB ? fromJPY(stayB.stayTaxJPY || [0, 0], people) : exact(0)
    );

    // Meals
    const mealDays = days - (stayB && stayB.includesMeals ? Number(calculationRules.ryokanMealCredit || 0) : 0);
    const mealLine = fromJPY(meal.perPersonPerDayJPY, people * mealDays * Number(city.mealFactor ?? 1));

    // City transport (per day on nights count; arrival/departure days are covered by airport transfer)
    const transportLine = sumLines(
      fromJPY(transport.perPersonPerDayJPY || [0, 0], people * nights),
      transport.perGroupOnceJPY ? fromJPY(transport.perGroupOnceJPY, Math.ceil(people / 9)) : exact(0)
    );

    // Airport transfer, excursion to stay B
    const airportLine = fromJPY(transferCost(airport, people));
    const excursionLine = stayB ? fromJPY(stayB.transferPerPersonJPY || [0, 0], people) : exact(0);

    // Activities: each ticket is its own estimate
    const activityLines = [];
    const fullDayLabels = [];
    city.activities.forEach((act) => {
      const value = s.activities[act.id];
      let qty = act.kind === "toggle" ? (value ? 1 : 0) : Number(value || 0);
      if (act.perUnitOf) qty = qty ? Number(s.activities[act.perUnitOf] || 0) : 0;
      if (qty <= 0) return;

      if (act.slot === "full") fullDayLabels.push(qty > 1 ? `${shortTitle(act.title)} ×${qty}` : shortTitle(act.title));

      if (act.groupJPY) {
        activityLines.push(fromJPY(act.groupJPY, qty));
        return;
      }
      const price = peak && act.peakAdultJPY ? act.peakAdultJPY : act.adultJPY;
      activityLines.push(fromJPY(price, people * qty));
    });

    const breakdown = {
      flight: flightLine,
      stay: stayLine,
      stayTax: stayTaxLine,
      meal: mealLine,
      airport: airportLine,
      transport: transportLine,
      excursion: excursionLine,
      activities: sumLines(...activityLines),
    };

    const subtotal = sumLines(...Object.values(breakdown));
    const contingency = subtotal.mean * Number(calculationRules.contingencyRate || 0);
    breakdown.contingency = exact(contingency);

    // Total: mean ± z·σ (σ² = sum of line variances), clamped to the all-low / all-high sums.
    const mean = subtotal.mean + contingency;
    const sd = Math.sqrt(subtotal.var);
    const extreme = [subtotal.lo + contingency, subtotal.hi + contingency];
    const band = [Math.max(extreme[0], mean - BAND_Z * sd), Math.min(extreme[1], mean + BAND_Z * sd)];
    const total = { mean, band, extreme };
    const perPerson = { mean: mean / people, band: scale(band, 1 / people), extreme: scale(extreme, 1 / people) };

    Object.entries(breakdown).forEach(([label, line]) => {
      if (line.lo > line.hi) console.error(`[range-error] ${cityId}.${label}: min > max`, line);
    });

    const roomSummary = stayAInfo.usesUnits
      ? `2룸 레지던스 ${stayAInfo.rooms}채 × ${nightsA}박`
      : `${roomConfig.title} · ${stayAInfo.rooms}실 × ${nightsA}박`;
    const avgFactorA = nightsA ? sum(factorsA) / nightsA : 0;
    const stayNote = [stayB ? `${roomSummary} + ${stayB.short || "B숙소"} 1박` : roomSummary];
    if (nightsA) stayNote.push(`평일가 대비 평균 ×${avgFactorA.toFixed(2)}`);
    const nightFactorText = [...factorsA, ...factorsB].map((factor, i) => `${formatDate(addDays(start, i))} ×${factor.toFixed(2).replace(/0$/, "")}`).join(", ");

    return {
      cityId,
      people,
      nights,
      nightsA,
      startDate: start,
      stayB,
      roomsA: stayAInfo.rooms,
      roomsB: stayBInfo.rooms,
      usesUnits: stayAInfo.usesUnits || stayBInfo.usesUnits,
      roomSummary: stayB ? `${roomSummary} + ${stayB.short || "B숙소"} 1박` : roomSummary,
      stayNote: stayNote.join(" · "),
      nightFactorText,
      mealDays: round1(mealDays),
      flightNote: applied("flight")
        ? `${flight.title} · 확정가 1인 ${formatManwon(quotes.flight.krw)}`
        : `${flight.title} · 1인 ${formatKRWRange(flightPerPerson)}`,
      fullDayLabels,
      breakdown,
      total,
      perPerson,
      quoteKeys,
      quoteContext,
      quoteStatus,
      estimates,
    };
  }

  // [lo, hi] treated as P10-P90 of a normal estimate: σ = (hi - lo) / (2·z).
  function estimate(r, factor = 1) {
    const lo = r[0] * factor;
    const hi = r[1] * factor;
    const sd = (hi - lo) / (2 * BAND_Z);
    return { lo, hi, mean: (lo + hi) / 2, var: sd * sd, locked: false, partial: false };
  }

  function exact(value, locked = false) {
    return { lo: value, hi: value, mean: value, var: 0, locked, partial: false };
  }

  function sumLines(...lines) {
    return lines.reduce(
      (acc, line) => ({ lo: acc.lo + line.lo, hi: acc.hi + line.hi, mean: acc.mean + line.mean, var: acc.var + line.var, locked: false, partial: false }),
      exact(0)
    );
  }

  function nightFactors(startIso, count) {
    const calendar = data.lodgingCalendar || {};
    return Array.from({ length: Math.max(0, count) }, (_, i) => {
      const iso = addDays(startIso, i);
      const special = calendar.dates ? Number(calendar.dates[iso]) : NaN;
      if (Number.isFinite(special)) return special;
      const weekday = Number((calendar.weekday || [])[weekdayOf(iso)]);
      return Number.isFinite(weekday) ? weekday : 1;
    });
  }

  function transferCost(option, people) {
    if (option.perVehicleRoundtripJPY) {
      return scale(option.perVehicleRoundtripJPY, Math.ceil(people / Number(option.vehicleCapacity || 4)));
    }
    return scale(option.perPersonRoundtripJPY || [0, 0], people);
  }

  function roomCountFor(roomConfig, people) {
    return Math.ceil(people / Math.max(1, Number(roomConfig.occupancy || 2)));
  }

  function emptyStay() {
    return { cost: [0, 0], rooms: 0, kind: "none", usesUnits: false };
  }

  // factors: one calendar multiplier per night (weekday card price = 1.0)
  function stayCost(stay, roomConfig, people, factors) {
    if (!factors.length) return emptyStay();
    const nightUnits = sum(factors);

    // Ryokan: per-person price, adjusted by how many share a room (solo use costs more).
    if (stay.perPersonPerNightJPY) {
      const rooms = roomCountFor(roomConfig, people);
      const factor = Number(roomConfig.perPersonFactor ?? 1);
      return { cost: scale(stay.perPersonPerNightJPY, people * nightUnits * factor), rooms, kind: roomConfig.id, usesUnits: false };
    }

    // Apartment: fixed price per unit, room config does not apply.
    if (stay.perUnitPerNightJPY) {
      const rooms = Math.ceil(people / Number(stay.unitCapacity || 4));
      return { cost: scale(stay.perUnitPerNightJPY, rooms * nightUnits), rooms, kind: "unit", usesUnits: true };
    }

    // Hotel: card price is a twin room; occupancy changes room count and per-room price.
    const rooms = roomCountFor(roomConfig, people);
    const factor = Number(roomConfig.priceFactor ?? 1);
    return { cost: scale(stay.perRoomPerNightJPY, rooms * nightUnits * factor), rooms, kind: roomConfig.id, usesUnits: false };
  }

  // ---------- Timeline ----------
  function buildTimeline(city, s, result) {
    const nights = result.nights;
    const dayCount = nights + 1;
    const flight = findById(city.flights, s.flightId);
    const airport = findById(airportOptionsFor(city, flight), s.airportId);
    const days = Array.from({ length: dayCount }, (_, i) => ({
      date: addDays(result.startDate, i),
      kind: "open",
      items: [],
      main: null,
    }));

    const last = dayCount - 1;
    days[0].kind = "arrival";
    days[last].kind = "departure";
    const bDay = result.stayB ? last - 1 : -1;
    if (bDay > 0) days[bDay].kind = "toB";

    const fullQueue = [];
    const halfQueue = [];
    const eveningQueue = [];
    city.activities.forEach((act) => {
      const value = s.activities[act.id];
      const qty = act.kind === "toggle" ? (value ? 1 : 0) : Number(value || 0);
      for (let i = 0; i < qty; i += 1) {
        const label = qty > 1 ? `${act.timeline} (${i + 1}일차)` : act.timeline;
        if (act.slot === "full") fullQueue.push(label);
        else if (act.slot === "half") halfQueue.push(act.timeline);
        else if (act.slot === "evening") eveningQueue.push(act.timeline);
      }
    });

    const openDays = days.filter((day) => day.kind === "open");
    const overflow = [];
    fullQueue.forEach((label) => {
      const target = openDays.find((day) => !day.main);
      if (target) {
        target.main = label;
        target.kind = "full";
      } else {
        overflow.push(label);
      }
    });

    let freeIndex = 0;
    openDays
      .filter((day) => !day.main)
      .forEach((day) => {
        day.main = city.freeDays[freeIndex % city.freeDays.length];
        freeIndex += 1;
      });

    // Half-day items go to free days first, then the move-to-B morning, then the arrival afternoon.
    const halfTargets = [...days.filter((day) => day.kind === "open"), ...days.filter((day) => day.kind === "toB"), days[0]];
    halfQueue.forEach((label, index) => {
      if (!halfTargets.length) {
        overflow.push(label);
        return;
      }
      halfTargets[index % halfTargets.length].items.push(label);
    });

    // Evening items: any night spent in the city (not the ryokan night, not departure).
    const eveningTargets = days.filter((day) => day.kind === "open" || day.kind === "full" || day.kind === "arrival");
    eveningQueue.forEach((label, index) => {
      if (!eveningTargets.length) {
        overflow.push(label);
        return;
      }
      const target = eveningTargets[(index + 1) % eveningTargets.length];
      target.items.push(`저녁 ${label}`);
    });

    const airportLabel = airport ? airport.short || airport.title : "공항 이동";
    days.forEach((day) => {
      if (day.kind === "arrival") {
        day.items.unshift(`${flight.airport} 도착 → ${airportLabel} → 체크인`);
      } else if (day.kind === "departure") {
        day.items = result.stayB
          ? [`${result.stayB.short || "B숙소"} 체크아웃 → 공항 → 귀국`]
          : [`체크아웃 → ${airportLabel} → 귀국`];
      } else if (day.kind === "toB") {
        day.items.unshift(day.items.length ? "오전 시내" : "오전 시내 자유");
        day.items.push(`오후 ${result.stayB.short || "B숙소"} 이동 · ${result.stayB.includesMeals ? "온천·석식" : "체크인"}`);
      } else if (day.main) {
        day.items.unshift(day.main);
      }
    });

    return { days, overflow };
  }

  // ---------- Helpers ----------
  function airportOptionsFor(city, flight) {
    const all = city.airportTransfers || [];
    if (!flight) return all;
    const filtered = all.filter((option) => !option.airports || option.airports.includes(flight.airport));
    return filtered.length ? filtered : all;
  }

  function currentDuration() {
    return findById(data.durations, state.durationId) || data.durations[0];
  }

  function currentSeason() {
    return findById(data.seasons, state.seasonId) || data.seasons[0];
  }

  function currentFx() {
    return findById(data.fxOptions, state.fxId) || data.fxOptions[0];
  }

  function cheapestCityId(results) {
    let best = null;
    cityOrder.forEach((cityId) => {
      const mid = results[cityId].perPerson.mean;
      if (!best || mid < best.mid) best = { cityId, mid };
    });
    return best ? best.cityId : null;
  }

  function describeStayPrice(stay) {
    if (stay.perPersonPerNightJPY) return `평일 1인 ${formatJPYRange(stay.perPersonPerNightJPY)}/박`;
    if (stay.perUnitPerNightJPY) return `평일 ${stay.unitCapacity}인 1채 ${formatJPYRange(stay.perUnitPerNightJPY)}/박`;
    if (stay.perRoomPerNightJPY) return `평일 트윈 ${formatJPYRange(stay.perRoomPerNightJPY)}/박`;
    return "";
  }

  function describeActivityPrice(act, season) {
    if (act.groupJPY) return "무료";
    const peak = season.parkTier === "peak";
    const price = peak && act.peakAdultJPY ? act.peakAdultJPY : act.adultJPY;
    const parts = [`1인 ${formatJPYRange(price)}`];
    if (act.note) parts.push(act.note);
    if (peak && act.peakAdultJPY) parts.push("성수기 등급");
    return parts.join(" · ");
  }

  function bookingUrl(query, checkin, checkout, rooms) {
    const params = new URLSearchParams({
      ss: query,
      checkin,
      checkout,
      group_adults: String(state.travelers),
      group_children: "0",
      no_rooms: String(Math.max(1, rooms || 1)),
      lang: "ko",
      selected_currency: "KRW",
    });
    return `https://www.booking.com/searchresults.ko.html?${params.toString()}`;
  }

  function shortTitle(title) {
    return String(title).replace(/\(.+?\)/g, "").replace(/\s+/g, " ").trim();
  }

  function titleOf(list, id) {
    const found = findById(list, id);
    return found ? found.title : "-";
  }

  function findById(list, id) {
    return (Array.isArray(list) ? list : []).find((item) => item.id === id) || null;
  }

  function pickId(list, preferredId) {
    const items = Array.isArray(list) ? list : [];
    if (!items.length) return null;
    return items.some((item) => item.id === preferredId) ? preferredId : items[0].id;
  }

  function clamp(value, min, max) {
    const parsed = Number(value);
    const safe = Number.isFinite(parsed) ? parsed : min;
    return Math.max(min, Math.min(max, safe));
  }

  function scale(r, factor) {
    return [r[0] * factor, r[1] * factor];
  }

  function sum(values) {
    return values.reduce((acc, value) => acc + value, 0);
  }

  function addDays(isoDate, offset) {
    const [y, m, d] = isoDate.split("-").map(Number);
    const date = new Date(Date.UTC(y, m - 1, d + offset));
    return date.toISOString().slice(0, 10);
  }

  function weekdayOf(isoDate) {
    const [y, m, d] = isoDate.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  }

  function formatDate(isoDate) {
    const [, m, d] = isoDate.split("-").map(Number);
    return `${m}/${d}(${WEEKDAYS[weekdayOf(isoDate)]})`;
  }

  function formatManwon(value) {
    return `${Math.round(value / 10000).toLocaleString("ko-KR")}만원`;
  }

  // Compact band: "136–158만원" (single value when both ends round the same)
  function formatBand(r) {
    const lo = Math.round(r[0] / 10000);
    const hi = Math.round(r[1] / 10000);
    if (lo === hi) return `${lo.toLocaleString("ko-KR")}만원`;
    return `${lo.toLocaleString("ko-KR")}–${hi.toLocaleString("ko-KR")}만원`;
  }

  function formatNumber(value) {
    return Math.round(value).toLocaleString("ko-KR");
  }

  // "320,000", "320000원", "32만", "32.5만" -> KRW integer; anything else -> 0 (clears the quote)
  function parseKRW(text) {
    const raw = String(text || "").replace(/[\s,원₩]/g, "");
    if (!raw) return 0;
    const man = raw.match(/^(\d+(?:\.\d+)?)만$/);
    const value = man ? Number(man[1]) * 10000 : /^\d+$/.test(raw) ? Number(raw) : 0;
    return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
  }

  function formatKRWRange(r) {
    return `${Math.round(r[0] / 10000).toLocaleString("ko-KR")}-${Math.round(r[1] / 10000).toLocaleString("ko-KR")}만원`;
  }

  function formatJPYRange(r) {
    if (r[0] === r[1]) return `¥${r[0].toLocaleString("ko-KR")}`;
    return `¥${r[0].toLocaleString("ko-KR")}-${r[1].toLocaleString("ko-KR")}`;
  }

  function pct(value) {
    return `${Math.round(value * 100)}%`;
  }

  function round1(value) {
    return Math.round(value * 10) / 10;
  }

  function byId(id) {
    return document.getElementById(id);
  }

  function esc(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }
})();
