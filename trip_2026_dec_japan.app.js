(() => {
  const data = window.JAPAN_TRIP_DATA;
  if (!data) {
    console.error("JAPAN_TRIP_DATA not found. Load data.js first.");
    return;
  }

  const STORAGE_KEY = "trip_2026_dec_japan.v2";
  const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];
  const { cities, cityOrder, calculationRules } = data;

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
    };
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
            <span class="price">${formatRange(r.perPerson)} <small>/ 1인</small></span>
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
    set("summary-city", `${city.name} · ${formatRange(result.perPerson)}`);
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
    el.perPersonTotal.textContent = `${formatRange(result.perPerson)} / 1인`;
    el.groupTotal.textContent = `총액 ${formatRange(result.total)} · ${result.people}명 · ${currentFx().title}`;

    const b = result.breakdown;
    const rows = [
      ["항공", b.flight, result.flightNote],
      ["숙박", b.stay, result.roomSummary],
      ["숙박세·입탕세", b.stayTax, "1인 1박 기준, 현장 결제"],
      ["식비", b.meal, `${result.mealDays}일 기준`],
      ["공항 이동", b.airport, titleOf(airportOptionsFor(city, findById(city.flights, cityState().flightId)), cityState().airportId)],
      ["시내 교통", b.transport, titleOf(city.transports, cityState().transportId)],
      ["근교 이동", b.excursion, result.stayB ? `${result.stayB.short || result.stayB.title} 왕복` : ""],
      ["액티비티", b.activities, ""],
      ["예비비", b.contingency, `${pct(calculationRules.contingencyRate.min)}-${pct(calculationRules.contingencyRate.max)}`],
    ].filter(([label, range]) => label !== "근교 이동" || range[1] > 0);

    el.breakdown.innerHTML = rows
      .map(
        ([label, range, note]) => `
          <li>
            <span>${esc(label)}${note ? `<small>${esc(note)}</small>` : ""}</span>
            <strong>${formatRange(range)}</strong>
          </li>
        `
      )
      .join("");
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
            <td><strong>${formatRange(r.perPerson)}</strong></td>
            <td>${formatRange(r.total)}</td>
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

  function renderCheckLinks(city, s, result) {
    const flight = findById(city.flights, s.flightId);
    const start = result.startDate;
    const end = addDays(start, result.nights);
    const links = [];

    const flightQuery = `Flights from ICN to ${flight.airport} on ${start} through ${end}`;
    links.push({
      label: `항공권 · ICN→${flight.airport} ${formatDate(start)}–${formatDate(end)}`,
      sub: "Google Flights",
      href: `https://www.google.com/travel/flights?hl=ko&curr=KRW&q=${encodeURIComponent(flightQuery)}`,
    });

    const stayA = findById(city.staysA, s.stayAId);
    const roomConfig = findById(data.roomConfigs, s.roomConfigId);
    const roomType = (stay) => {
      if (stay.perUnitPerNightJPY) return "2룸(침실 2개)";
      if (stay.perPersonPerNightJPY) return `${roomConfig.occupancy}인 1실`;
      return roomConfig.occupancy === 2 ? "트윈(침대 2개)" : roomConfig.title;
    };
    const checkoutA = addDays(start, result.nightsA);
    links.push({
      label: `A숙소 · ${stayA.title} ${formatDate(start)}–${formatDate(checkoutA)}`,
      sub: `Booking.com · ${roomType(stayA)} ${result.roomsA}${stayA.perUnitPerNightJPY ? "채" : "실"}`,
      href: bookingUrl(stayA.booking || city.bookingCity, start, checkoutA, result.roomsA),
    });

    if (result.stayB) {
      const checkinB = checkoutA;
      links.push({
        label: `B숙소 · ${result.stayB.title} ${formatDate(checkinB)}–${formatDate(addDays(checkinB, 1))}`,
        sub: `Booking.com · ${roomType(result.stayB)} ${result.roomsB}${result.stayB.perUnitPerNightJPY ? "채" : "실"}`,
        href: bookingUrl(result.stayB.booking || city.bookingCity, checkinB, addDays(checkinB, 1), result.roomsB),
      });
    }

    el.checkLinks.innerHTML = links
      .map(
        (link) => `
          <li>
            <a href="${esc(link.href)}" target="_blank" rel="noopener noreferrer">${esc(link.label)}</a>
            <small>${esc(link.sub)}</small>
          </li>
        `
      )
      .join("");
  }

  function renderNotes(city, s, result) {
    const notes = [...(currentSeason().notes || []), ...(city.notes || [])];
    const roomConfig = findById(data.roomConfigs, s.roomConfigId);
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
    const groups = [{ title: "공통 (환율·숙박세·시기·객실·식비)", items: collectShared() }];
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
    [...data.seasons, ...data.roomConfigs, ...data.mealLevels].forEach((item) => {
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
    const jpy = (r) => scale(r, fx);

    // Flight (KRW)
    const flightCost = scale(flight.priceKRW, people * season.flightFactor);

    // Airport transfer
    const airportCost = jpy(transferCost(airport, people));

    // Stays
    const stayAInfo = stayCost(stayA, roomConfig, people, nightsA, season.stayFactor);
    const stayBInfo = stayB ? stayCost(stayB, roomConfig, people, 1, season.stayFactor) : { cost: [0, 0], rooms: 0, usesUnits: false };
    const stayCostJPY = add(stayAInfo.cost, stayBInfo.cost);

    // Lodging / bathing tax (per person per night)
    let stayTaxJPY = scale(stayA.lodgingTaxJPY || [0, 0], people * nightsA);
    if (stayB) stayTaxJPY = add(stayTaxJPY, scale(stayB.stayTaxJPY || [0, 0], people));

    // Meals
    const mealDays = days - (stayB && stayB.includesMeals ? Number(calculationRules.ryokanMealCredit || 0) : 0);
    const mealJPY = scale(meal.perPersonPerDayJPY, people * mealDays * Number(city.mealFactor ?? 1));

    // City transport (per day on nights count; arrival/departure days are covered by airport transfer)
    let transportJPY = scale(transport.perPersonPerDayJPY || [0, 0], people * nights);
    if (transport.perGroupOnceJPY) {
      transportJPY = add(transportJPY, scale(transport.perGroupOnceJPY, Math.ceil(people / 9)));
    }

    // Excursion to stay B
    const excursionJPY = stayB ? scale(stayB.transferPerPersonJPY || [0, 0], people) : [0, 0];

    // Activities
    let activitiesJPY = [0, 0];
    const fullDayLabels = [];
    city.activities.forEach((act) => {
      const value = s.activities[act.id];
      let qty = act.kind === "toggle" ? (value ? 1 : 0) : Number(value || 0);
      if (act.perUnitOf) qty = qty ? Number(s.activities[act.perUnitOf] || 0) : 0;
      if (qty <= 0) return;

      if (act.slot === "full") fullDayLabels.push(qty > 1 ? `${shortTitle(act.title)} ×${qty}` : shortTitle(act.title));

      if (act.groupJPY) {
        activitiesJPY = add(activitiesJPY, scale(act.groupJPY, qty));
        return;
      }
      const price = peak && act.peakAdultJPY ? act.peakAdultJPY : act.adultJPY;
      activitiesJPY = add(activitiesJPY, scale(price, people * qty));
    });

    const breakdown = {
      flight: flightCost,
      stay: jpy(stayCostJPY),
      stayTax: jpy(stayTaxJPY),
      meal: jpy(mealJPY),
      airport: airportCost,
      transport: jpy(transportJPY),
      excursion: jpy(excursionJPY),
      activities: jpy(activitiesJPY),
    };

    const subtotal = add(...Object.values(breakdown));
    const contingency = [subtotal[0] * calculationRules.contingencyRate.min, subtotal[1] * calculationRules.contingencyRate.max];
    breakdown.contingency = contingency;
    const total = add(subtotal, contingency);
    const perPerson = [Math.floor(total[0] / people), Math.ceil(total[1] / people)];

    Object.entries(breakdown).forEach(([label, r]) => {
      if (r[0] > r[1]) console.error(`[range-error] ${cityId}.${label}: min > max`, r);
    });

    const roomSummary = stayAInfo.usesUnits
      ? `2룸 레지던스 ${stayAInfo.rooms}채 × ${nightsA}박`
      : `${roomConfig.title} · ${stayAInfo.rooms}실 × ${nightsA}박`;

    return {
      cityId,
      people,
      nights,
      nightsA,
      startDate: season.startDate,
      stayB,
      roomsA: stayAInfo.rooms,
      roomsB: stayBInfo.rooms,
      usesUnits: stayAInfo.usesUnits || stayBInfo.usesUnits,
      roomSummary: stayB ? `${roomSummary} + ${stayB.short || "B숙소"} 1박` : roomSummary,
      mealDays: round1(mealDays),
      flightNote: `${flight.title} · 1인 ${formatKRWRange(scale(flight.priceKRW, season.flightFactor))}`,
      fullDayLabels,
      breakdown,
      total,
      perPerson,
    };
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

  function stayCost(stay, roomConfig, people, nights, seasonFactor) {
    if (nights <= 0) return { cost: [0, 0], rooms: 0, usesUnits: false };

    // Ryokan: per-person price, adjusted by how many share a room (solo use costs more).
    if (stay.perPersonPerNightJPY) {
      const rooms = roomCountFor(roomConfig, people);
      const factor = Number(roomConfig.perPersonFactor ?? 1);
      return { cost: scale(stay.perPersonPerNightJPY, people * nights * factor * seasonFactor), rooms, usesUnits: false };
    }

    // Apartment: fixed price per unit, room config does not apply.
    if (stay.perUnitPerNightJPY) {
      const rooms = Math.ceil(people / Number(stay.unitCapacity || 4));
      return { cost: scale(stay.perUnitPerNightJPY, rooms * nights * seasonFactor), rooms, usesUnits: true };
    }

    // Hotel: card price is a twin room; occupancy changes room count and per-room price.
    const rooms = roomCountFor(roomConfig, people);
    const factor = Number(roomConfig.priceFactor ?? 1);
    return { cost: scale(stay.perRoomPerNightJPY, rooms * nights * factor * seasonFactor), rooms, usesUnits: false };
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
      const r = results[cityId];
      const mid = (r.perPerson[0] + r.perPerson[1]) / 2;
      if (!best || mid < best.mid) best = { cityId, mid };
    });
    return best ? best.cityId : null;
  }

  function describeStayPrice(stay) {
    if (stay.perPersonPerNightJPY) return `1인 ${formatJPYRange(stay.perPersonPerNightJPY)}/박`;
    if (stay.perUnitPerNightJPY) return `${stay.unitCapacity}인 1채 ${formatJPYRange(stay.perUnitPerNightJPY)}/박`;
    if (stay.perRoomPerNightJPY) return `트윈 ${formatJPYRange(stay.perRoomPerNightJPY)}/박`;
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

  function add(...ranges) {
    return ranges.reduce((acc, r) => [acc[0] + r[0], acc[1] + r[1]], [0, 0]);
  }

  function addDays(isoDate, offset) {
    const [y, m, d] = isoDate.split("-").map(Number);
    const date = new Date(Date.UTC(y, m - 1, d + offset));
    return date.toISOString().slice(0, 10);
  }

  function formatDate(isoDate) {
    const [y, m, d] = isoDate.split("-").map(Number);
    const weekday = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
    return `${m}/${d}(${weekday})`;
  }

  function formatRange(r) {
    return `${formatManwon(r[0])} - ${formatManwon(r[1])}`;
  }

  function formatManwon(value) {
    return `${Math.round(value / 10000).toLocaleString("ko-KR")}만원`;
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
