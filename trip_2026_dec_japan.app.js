(() => {
  const data = window.JAPAN_TRIP_DATA;
  if (!data) {
    console.error("JAPAN_TRIP_DATA not found. Load data.js first.");
    return;
  }

  const STORAGE_KEY = "trip_2026_dec_japan.v3";
  const UI_KEY = "trip_2026_dec_japan.ui.v1";
  const TABS = ["plan", "cost", "rx", "book"];
  const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];
  const { cities, cityOrder, calculationRules, rx, countries, currencies } = data;
  const BAND_Z = Number(calculationRules.bandZ || 1.2816);
  const QUOTE_FIELDS = [
    { field: "flight", label: "확정가 · 1인 왕복", placeholder: "예: 320,000" },
    { field: "stayPre", label: "확정가 · 숙박 총액", placeholder: "예: 80,000" },
    { field: "stayA", label: "확정가 · 숙박 총액", placeholder: "예: 450,000" },
    { field: "stayB", label: "확정가 · 숙박 총액", placeholder: "예: 400,000" },
  ];

  const el = {
    city: byId("city-options"),
    party: byId("party-controls"),
    departure: byId("departure-options"),
    duration: byId("duration-options"),
    season: byId("season-options"),
    fx: byId("fx-options"),
    rxPlan: byId("rxPlan-options"),
    rxDay: byId("rxDay-options"),
    rxPatients: byId("rxPatients-controls"),
    clinic: byId("clinic-options"),
    flight: byId("flight-options"),
    airport: byId("airport-options"),
    stayPre: byId("stayPre-options"),
    roomConfig: byId("roomConfig-options"),
    stayA: byId("stayA-options"),
    stayB: byId("stayB-options"),
    meal: byId("meal-options"),
    transport: byId("transport-options"),
    activityControls: byId("activity-controls"),
    activityPacks: byId("activityPack-options"),
    titleStayA: byId("title-stayA"),
    titleStayPre: byId("title-stayPre"),
    titleClinic: byId("title-clinic"),
    titleActivities: byId("title-activities"),
    titleFx: byId("title-fx"),
    labelRxPlan: byId("label-rxPlan"),
    rxPrep: byId("rx-prep"),
    cash: byId("cash-list"),
    cashTitle: byId("cash-title"),
    cashNote: byId("cash-note"),
    resultContext: byId("result-context"),
    perPersonTotal: byId("per-person-total"),
    perPersonBand: byId("per-person-band"),
    groupTotal: byId("group-total"),
    perMonth: byId("per-month"),
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
    cardsPanel: byId("cards-panel"),
    resultPanel: byId("result-panel"),
    resultScroll: byId("result-scroll"),
    resultDelta: byId("result-delta"),
    tablist: byId("result-tabs"),
    tabs: Array.from(document.querySelectorAll("#result-tabs [role=tab]")),
    tabPlanBadge: byId("tab-plan-badge"),
    toggleAll: byId("toggle-all"),
    cityDivider: byId("city-divider"),
    warnSlots: { rx: byId("warn-rx"), clinic: byId("warn-clinic"), stayB: byId("warn-stayB"), activities: byId("warn-activities") },
    mobileBarTotal: byId("mobile-bar-total"),
    mobileBarDelta: byId("mobile-bar-delta"),
    mobileBarSub: byId("mobile-bar-sub"),
    mobileBarJump: byId("mobile-bar-jump"),
    toast: byId("toast"),
    toastText: byId("toast-text"),
    toastAction: byId("toast-action"),
  };
  // Containers whose buttons are rebuilt on every render.
  const rerenderHosts = [
    el.city, el.party, el.departure, el.duration, el.season, el.fx, el.rxPlan, el.rxDay, el.rxPatients, el.clinic, el.flight, el.airport,
    el.stayPre, el.roomConfig, el.stayA, el.stayB, el.meal, el.transport, el.activityControls, el.activityPacks, el.compareBody,
  ];
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const state = loadState() || createInitialState();
  state.ui = loadUi();
  let pressed = null; // the button a click landed on, noted before the handlers re-render it
  let lastMean = null;
  let deltaTimer = null;
  let toastTimer = null;
  let toastUndo = null;
  let cardsMark = null; // where the reader was in the cards before jumping to the result on a phone

  bindEvents();
  render();
  renderEvidence();
  updateMobileBar();

  // ---------- State ----------
  function createInitialState() {
    const perCity = {};
    cityOrder.forEach((cityId) => {
      perCity[cityId] = createCityState(cityId);
    });

    return {
      cityId: cityOrder[0],
      travelers: data.party.travelers.defaultValue,
      departureId: data.departures[0].id,
      durationId: "n3",
      seasonId: "w1211",
      fx: pickFx({}),
      rxPlan: pickRxPlans({}),
      rxDayId: "rx_d2",
      rxPatients: rx.patients.defaultValue,
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
      clinicId: pickId(city.clinics, d.clinicId),
      stayPreId: pickId(city.staysPre, d.stayPreId),
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

  // The plan (doses and weeks) is picked per country, because the two countries sell different pens.
  function pickRxPlans(saved) {
    const result = {};
    Object.values(countries).forEach((country) => {
      result[country.id] = pickId(country.rxPlans, saved[country.id] || country.defaultRxPlanId);
    });
    return result;
  }

  // One rate per currency, shared by that country's cities.
  function pickFx(saved) {
    const result = {};
    Object.values(currencies).forEach((currency) => {
      result[currency.code] = pickId(currency.fxOptions, saved[currency.code]);
    });
    return result;
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
    try {
      return parseState(window.localStorage.getItem(STORAGE_KEY));
    } catch (error) {
      return null;
    }
  }

  function parseState(raw) {
    if (!raw) return null;

    try {
      const saved = JSON.parse(raw);
      const base = createInitialState();
      const next = {
        cityId: cities[saved.cityId] ? saved.cityId : base.cityId,
        travelers: clamp(saved.travelers ?? base.travelers, data.party.travelers.min, data.party.travelers.max),
        departureId: pickId(data.departures, saved.departureId || base.departureId),
        durationId: pickId(data.durations, saved.durationId || base.durationId),
        seasonId: pickId(data.seasons, saved.seasonId || base.seasonId),
        // Selections saved before China was added hold a single yen rate in fxId.
        fx: pickFx(saved.fx || { JPY: saved.fxId }),
        // Selections saved before China was added hold one plan in rxPlanId; it was a Japanese plan.
        rxPlan: pickRxPlans(saved.rxPlan || { jp: saved.rxPlanId }),
        rxDayId: pickId(rx.days, saved.rxDayId || base.rxDayId),
        cities: {},
      };
      next.rxPatients = clamp(saved.rxPatients ?? base.rxPatients, rx.patients.min, next.travelers);

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
          clinicId: pickId(city.clinics, savedCity.clinicId || fallback.clinicId),
          stayPreId: pickId(city.staysPre, savedCity.stayPreId || fallback.stayPreId),
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

  function serializeState() {
    const { ui, ...rest } = state;
    return JSON.stringify(rest);
  }

  function saveState() {
    try {
      window.localStorage.setItem(STORAGE_KEY, serializeState());
    } catch (error) {
      // Storage can be unavailable (private mode, blocked site data); the page works without it.
    }
  }

  // Open sections and the result tab are remembered per browser, apart from the trip selections.
  function loadUi() {
    const ui = { accordion: createInitialAccordionState(), tab: TABS[0] };
    try {
      const saved = JSON.parse(window.localStorage.getItem(UI_KEY) || "null");
      if (saved && typeof saved === "object") {
        Object.keys(ui.accordion).forEach((section) => {
          const value = saved.accordion ? saved.accordion[section] : undefined;
          if (typeof value === "boolean") ui.accordion[section] = value;
        });
        if (TABS.includes(saved.tab)) ui.tab = saved.tab;
      }
    } catch (error) {
      // Fall back to the defaults.
    }
    return ui;
  }

  function saveUi() {
    try {
      window.localStorage.setItem(UI_KEY, JSON.stringify(state.ui));
    } catch (error) {
      // Same as saveState: optional.
    }
  }

  // The choices that shape the trip start open; the rest show their current pick in the header.
  function createInitialAccordionState() {
    const mobile = window.matchMedia("(max-width: 768px)").matches;
    const open = new Set(
      mobile ? ["city", "schedule", "rx", "clinic"] : ["city", "party", "schedule", "rx", "clinic", "flight", "stayPre", "stayA", "activities"]
    );
    const result = {};
    el.categories.forEach((categoryEl) => {
      result[categoryEl.dataset.section] = open.has(categoryEl.dataset.section);
    });
    return result;
  }

  function cityState(cityId = state.cityId) {
    return state.cities[cityId];
  }

  // ---------- Events ----------
  function bindEvents() {
    // Runs before the handlers below: note which button was pressed, so commit() can find its replacement.
    document.addEventListener(
      "click",
      (event) => {
        const btn = event.target instanceof Element ? event.target.closest("button") : null;
        const host = btn ? rerenderHosts.find((node) => node.contains(btn)) : null;
        pressed = host
          ? {
              host,
              index: Array.from(host.querySelectorAll("button")).indexOf(btn),
              top: btn.getBoundingClientRect().top,
              focused: document.activeElement === btn,
            }
          : null;
      },
      true
    );

    onCardClick(el.city, (id) => {
      if (cities[id]) state.cityId = id;
    });
    onCardClick(el.departure, (id) => {
      state.departureId = id;
    });
    onCardClick(el.duration, (id) => {
      state.durationId = id;
    });
    onCardClick(el.rxPlan, (id) => {
      state.rxPlan[cities[state.cityId].country] = id;
    });
    onCardClick(el.rxDay, (id) => {
      state.rxDayId = id;
    });
    onCardClick(el.clinic, (id) => {
      cityState().clinicId = id;
    });
    onCardClick(el.stayPre, (id) => {
      cityState().stayPreId = id;
    });
    el.rxPatients.addEventListener("click", (event) => {
      const btn = event.target.closest("button[data-rx-patients]");
      if (!btn) return;
      state.rxPatients = clamp(Number(btn.dataset.rxPatients), rx.patients.min, state.travelers);
      commit();
    });
    onCardClick(el.season, (id) => {
      state.seasonId = id;
    });
    onCardClick(el.fx, (id) => {
      state.fx[moneyFor(cities[state.cityId]).code] = id;
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
      state.rxPatients = clamp(state.rxPatients, rx.patients.min, state.travelers);
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
      s.activities = packActivities(city, s.activities, pack);
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
      pressed = null;
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
        saveUi();
        renderAccordion();
      });
    });

    el.toggleAll.addEventListener("click", () => {
      const anyOpen = Object.values(state.ui.accordion).some(Boolean);
      Object.keys(state.ui.accordion).forEach((section) => {
        state.ui.accordion[section] = !anyOpen;
      });
      saveUi();
      renderAccordion();
    });

    el.tabs.forEach((tab) => {
      tab.addEventListener("click", () => selectTab(tab.dataset.tab));
    });
    el.tablist.addEventListener("keydown", (event) => {
      const index = TABS.indexOf(state.ui.tab);
      const next =
        event.key === "ArrowRight" ? (index + 1) % TABS.length
        : event.key === "ArrowLeft" ? (index + TABS.length - 1) % TABS.length
        : event.key === "Home" ? 0
        : event.key === "End" ? TABS.length - 1
        : -1;
      if (next < 0) return;
      event.preventDefault();
      selectTab(TABS[next]);
      byId(`tab-${TABS[next]}`).focus();
    });

    // Phone only (the bar is hidden on wide screens): hop between the result and the cards without losing the place.
    el.mobileBarJump.addEventListener("click", () => {
      if (viewingResult()) {
        const mark = cardsMark;
        cardsMark = null;
        smoothScrollBy(mark ? mark.node.getBoundingClientRect().top - mark.offset : el.cardsPanel.getBoundingClientRect().top - 8);
      } else {
        const node = el.categories.find((categoryEl) => categoryEl.getBoundingClientRect().bottom > 80) || el.categories[0];
        cardsMark = { node, offset: node.getBoundingClientRect().top };
        smoothScrollBy(el.resultPanel.getBoundingClientRect().top - 8);
      }
    });
    let barFrame = 0;
    const scheduleBarUpdate = () => {
      if (barFrame) return;
      barFrame = window.requestAnimationFrame(() => {
        barFrame = 0;
        updateMobileBar();
      });
    };
    window.addEventListener("scroll", scheduleBarUpdate, { passive: true });
    window.addEventListener("resize", scheduleBarUpdate);

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

    // Reset also drops typed quotes, so it can be undone for a few seconds.
    el.resetState.addEventListener("click", () => {
      const before = serializeState();
      const ui = state.ui;
      Object.assign(state, createInitialState(), { ui });
      commit();
      showToast("선택을 처음 상태로 되돌렸습니다.", "실행 취소", () => {
        const restored = parseState(before);
        if (!restored) return;
        Object.assign(state, restored, { ui });
        commit();
      });
    });
    el.toastAction.addEventListener("click", () => {
      const undo = toastUndo;
      hideToast();
      if (undo) undo();
    });
  }

  function showToast(text, actionLabel, onUndo) {
    el.toastText.textContent = text;
    el.toastAction.textContent = actionLabel;
    toastUndo = onUndo;
    el.toast.hidden = false;
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(hideToast, 8000);
  }

  function hideToast() {
    window.clearTimeout(toastTimer);
    el.toast.hidden = true;
    toastUndo = null;
  }

  function selectTab(id) {
    if (!TABS.includes(id) || id === state.ui.tab) return;
    state.ui.tab = id;
    saveUi();
    renderTabs();
    el.resultScroll.scrollTop = 0;
    // On a phone the tab bar sticks to the top of the screen; start the new panel right under it.
    const barBottom = el.tablist.getBoundingClientRect().bottom;
    const panelTop = el.resultScroll.getBoundingClientRect().top;
    if (panelTop < barBottom - 1) window.scrollBy(0, panelTop - barBottom);
  }

  function renderTabs() {
    el.tabs.forEach((tab) => {
      const active = tab.dataset.tab === state.ui.tab;
      tab.setAttribute("aria-selected", String(active));
      tab.tabIndex = active ? 0 : -1;
      byId(tab.getAttribute("aria-controls")).hidden = !active;
    });
  }

  function viewingResult() {
    return el.cardsPanel.getBoundingClientRect().top > window.innerHeight * 0.5;
  }

  function updateMobileBar() {
    el.mobileBarJump.textContent = viewingResult() ? "옵션 바꾸기 ↓" : "결과 보기 ↑";
  }

  function smoothScrollBy(top) {
    window.scrollBy({ top, behavior: reduceMotion ? "auto" : "smooth" });
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

  // Every change re-renders the cards. The pressed button is put back in focus and held at the same
  // spot on screen (on a phone the result above the cards changes height with almost every choice).
  function commit() {
    saveState();
    const mark = pressed;
    pressed = null;
    render(true);
    if (!mark) return;
    const btn = mark.host.querySelectorAll("button")[mark.index];
    if (!btn) return;
    if (mark.focused) btn.focus({ preventScroll: true });
    if (!el.cardsPanel.contains(mark.host)) return;
    const shift = btn.getBoundingClientRect().top - mark.top;
    if (Math.abs(shift) > 1) window.scrollBy(0, shift);
  }

  // ---------- Render ----------
  function render(showChange = false) {
    const city = cities[state.cityId];
    const country = countryOf(city);
    const money = moneyFor(city);
    const s = cityState();
    const flight = findById(city.flights, s.flightId);
    const results = {};
    cityOrder.forEach((cityId) => {
      results[cityId] = compute(cityId);
    });
    const result = results[state.cityId];
    const base = result.perPerson.mean;
    // What each other card would do to the per-person mean.
    const ifShared = (key) => (item) => meanIf({ [key]: item.id }) - base;
    const ifCity = (key) => (item) => meanIf(null, { [key]: item.id }) - base;

    renderCityCards(results);
    renderParty();
    renderCards(el.departure, data.departures, state.departureId, null, ifShared("departureId"));
    renderCards(el.duration, data.durations, state.durationId, null, ifShared("durationId"));
    renderCards(el.season, data.seasons.map((item) => forCountry(item, country)), state.seasonId, null, ifShared("seasonId"));
    renderCards(el.fx, money.currency.fxOptions, money.fx.id, null, (item) => meanIf({ fx: { ...state.fx, [money.code]: item.id } }) - base);
    renderCards(
      el.rxPlan,
      country.rxPlans.map((plan) => ({ ...plan, title: planTitle(plan, country) })),
      state.rxPlan[country.id],
      (item) => {
        const month = perRxMonth(computeIf({ rxPlan: { ...state.rxPlan, [country.id]: item.id } }));
        return month ? `${item.subtitle} · 1개월분당 약 ${formatManwon(month.mean)}` : item.subtitle;
      },
      (item) => meanIf({ rxPlan: { ...state.rxPlan, [country.id]: item.id } }) - base
    );
    renderCards(
      el.rxDay,
      rx.days,
      state.rxDayId,
      (item) => `${formatDate(addDays(result.startDate, item.dayIndex))} · ${item.subtitle}`,
      ifShared("rxDayId")
    );
    renderRxPatients(country);
    renderCards(
      el.clinic,
      city.clinics,
      s.clinicId,
      (item) => `${item.subtitle} · 이 플랜 1인 ${money.format(rxDrugCost(item, rxPlanFor(country), money))}`,
      ifCity("clinicId")
    );
    renderCards(el.flight, city.flights, s.flightId, (item) => `${item.subtitle} · ${formatKRWRange(item.priceKRW)}`, ifCity("flightId"));
    renderCards(el.airport, airportOptionsFor(city, flight), s.airportId, null, ifCity("airportId"));
    renderCards(el.stayPre, city.staysPre, s.stayPreId, (item) => `${item.subtitle} · ${describeStayPrice(item, money)}`, ifCity("stayPreId"));
    renderCards(
      el.roomConfig,
      data.roomConfigs.map((item) => forCountry(item, country)),
      s.roomConfigId,
      (item) => `${item.subtitle} · ${state.travelers}명 → ${roomCountFor(item, state.travelers)}실`,
      ifCity("roomConfigId")
    );
    renderCards(el.stayA, city.staysA, s.stayAId, (item) => `${item.subtitle} · ${describeStayPrice(item, money)}`, ifCity("stayAId"));
    renderCards(
      el.stayB,
      city.staysB,
      s.stayBId,
      (item) => (item.id === "none" ? item.subtitle : `${item.subtitle} · ${describeStayPrice(item, money)}`),
      ifCity("stayBId")
    );
    renderCards(
      el.meal,
      data.mealLevels.map((item) => forCountry(item, country)),
      s.mealId,
      (item) => `${item.subtitle} · 1인 ${money.format(money.of(item, "perPersonPerDay"))}/일`,
      ifCity("mealId")
    );
    renderCards(el.transport, city.transports, s.transportId, null, ifCity("transportId"));
    renderActivityControls(city, s, money);
    renderCards(el.activityPacks, city.packs, s.packId, null, (pack) => meanIf(null, { activities: packActivities(city, s.activities, pack) }) - base);

    if (el.titleStayA) el.titleStayA.textContent = `처방 후 숙소 · 2인 1실 (${result.nightsA}박)`;
    if (el.titleStayPre) el.titleStayPre.textContent = `처방 전 숙소 · 초저가 (${result.preNights}박)`;
    if (el.titleClinic) el.titleClinic.textContent = `처방 클리닉 · 수령 방식 · ${city.name}`;
    if (el.titleActivities) el.titleActivities.textContent = `관광 · 이색 식사 · ${city.name}`;
    if (el.titleFx) el.titleFx.textContent = `환율 · ${money.currency.name}`;
    if (el.labelRxPlan) el.labelRxPlan.textContent = `용량 · 수량 · ${country.name} 도시 공통 (${country.penNote})`;
    el.cityDivider.textContent = `여기부터는 도시마다 따로 저장됩니다 · 지금 ${city.name}`;

    const plan = buildTimeline(city, s, result);
    const warnings = [...plan.warnings];
    if (plan.overflow.length) {
      warnings.push({
        scopes: ["activities"],
        conflict: true,
        text: `일정 초과: ${plan.overflow.join(", ")} 은(는) 들어갈 날이 없습니다. 기간·출발 방식을 바꾸거나 수량을 줄이세요.`,
      });
    }
    const conflicts = warnings.filter((warning) => warning.conflict).length;

    renderSummaries(city, s, result);
    renderAccordion();
    renderTabs();
    renderResult(city, result);
    renderChange(showChange && lastMean !== null ? base - lastMean : 0);
    lastMean = base;
    renderCompare(results);
    renderTimeline(plan, warnings);
    renderWarnings(warnings, conflicts);
    renderRxPrep(city, s, result);
    renderCheckLinks(city, s, result);
    renderNotes(city, s, result);

    el.mobileBarTotal.textContent = `약 ${formatManwon(base)} / 1인`;
    el.mobileBarSub.textContent = `${city.name} · ${currentDuration().title}${conflicts ? ` · 주의 ${conflicts}건` : ""}`;
  }

  // Per-person mean if some selections were different; nothing is saved or re-rendered.
  function meanIf(sharedPatch, cityPatch) {
    return computeIf(sharedPatch, cityPatch).perPerson.mean;
  }

  // The current city's full result if some selections were different; nothing is saved or re-rendered.
  function computeIf(sharedPatch, cityPatch) {
    const s = cityState();
    const keepShared = {};
    const keepCity = {};
    Object.keys(sharedPatch || {}).forEach((key) => {
      keepShared[key] = state[key];
      state[key] = sharedPatch[key];
    });
    Object.keys(cityPatch || {}).forEach((key) => {
      keepCity[key] = s[key];
      s[key] = cityPatch[key];
    });
    try {
      return compute(state.cityId);
    } finally {
      Object.assign(state, keepShared);
      Object.assign(s, keepCity);
    }
  }

  function packActivities(city, current, pack) {
    const next = { ...current };
    Object.entries(pack.apply || {}).forEach(([key, value]) => {
      const act = findById(city.activities, key);
      if (!act) return;
      next[key] = act.kind === "toggle" ? Boolean(value) : clamp(Number(value), act.min ?? 0, act.max ?? 0);
    });
    return next;
  }

  // "+3만원" next to the total for a few seconds after a change.
  function renderChange(delta) {
    const text = formatDelta(delta);
    const nodes = [el.resultDelta, el.mobileBarDelta];
    nodes.forEach((node) => {
      node.hidden = !text;
      node.textContent = text;
      node.className = `delta-flash ${delta > 0 ? "is-up" : "is-down"}`;
    });
    window.clearTimeout(deltaTimer);
    if (!text) return;
    deltaTimer = window.setTimeout(() => {
      nodes.forEach((node) => {
        node.hidden = true;
      });
    }, 6000);
  }

  // Each warning is shown where it can be fixed, and the section header is marked while it is closed.
  function renderWarnings(warnings, conflicts) {
    Object.entries(el.warnSlots).forEach(([scope, node]) => {
      const mine = warnings.filter((warning) => warning.scopes.includes(scope));
      node.hidden = !mine.length;
      node.innerHTML = mine.map((warning) => esc(warning.text)).join("<br />");
      const categoryEl = node.closest(".category");
      if (categoryEl) categoryEl.classList.toggle("has-warning", mine.some((warning) => warning.conflict));
    });
    el.tabPlanBadge.hidden = !conflicts;
    el.tabPlanBadge.textContent = conflicts ? `주의 ${conflicts}` : "";
  }

  function renderRxPatients(country) {
    const buttons = [];
    for (let qty = rx.patients.min; qty <= state.travelers; qty += 1) {
      const active = qty === state.rxPatients;
      buttons.push(
        `<button type="button" class="qty-btn ${active ? "active" : ""}" data-rx-patients="${qty}" aria-pressed="${active}">${qty}</button>`
      );
    }
    el.rxPatients.innerHTML = `
      <div class="activity-row">
        <span class="activity-label">처방받는 인원<small>1인 최대 ${importLimitPens(country)}펜(${esc(country.importLimitNote)})까지 국내 반입</small></span>
        <div class="qty-group" role="group" aria-label="처방받는 인원">${buttons.join("")}</div>
      </div>
    `;
  }

  function renderRxPrep(city, s, result) {
    const clinic = result.clinic;
    const country = countryOf(city);
    const rxDate = addDays(result.startDate, result.preNights);
    const booking = bookingStep(clinic, rxDate, planTitle(result.rxPlan, country));
    const items = [`<strong>${esc(booking.when)}</strong> ${esc(booking.text)}`];
    (clinic.prep || []).forEach((line) => items.push(esc(line)));
    if (clinic.link) {
      items.push(`<a href="${esc(clinic.link.href)}" target="_blank" rel="noopener noreferrer">${esc(clinic.link.label)}</a>`);
    }
    items.push(`결제: ${esc(clinic.payment)}`);
    items.push("여권 지참 (진료·수령 모두 본인 확인)");
    items.push(`귀국: 1인 ${importLimitPens(country)}펜 이하 · 영수증·처방 내역·원래 상자 · 펜은 기내 휴대. 출국 전 관세청(125)에 최신 기준 확인`);
    el.rxPrep.innerHTML = items.map((item) => `<li>${item}</li>`).join("");
    renderCash(result);
  }

  function renderCash(result) {
    const c = result.cash;
    const money = result.money;
    const currency = money.currency;
    const amount = (r) => money.format(r, "–");
    const clinic = result.clinic;
    const deposit = money.of(clinic, "deposit");
    const rxNote =
      clinic.cashPart === "ship"
        ? "약값은 카드 선결제, 배송비만 수령 때 현장 결제"
        : deposit
          ? `계약금 ${money.format([deposit, deposit])}/인 선결제 뒤 잔금 전액 (현장 결제 수단 미기재)`
          : currency.cashRxNote;
    const rows = [
      ["마운자로 (현금 대비)", c.rx, rxNote],
      ["숙박세·입탕세", c.tax, "프런트 현장 결제가 많음"],
      ["현금 위주 식사", c.activities, "시장 식당·노점 (선택한 항목만)"],
      [currency.cashBufferLabel, c.buffer, `1인 ${money.format(currency.cashBuffer)} · ${currency.cashBufferNote}`],
    ].filter(([, r]) => r[1] > 0);
    const recommended = roundUp(c.total[1], currency.cashStep);
    el.cashTitle.textContent = `준비할 ${currency.name} 현금`;
    el.cashNote.textContent = currency.cashNote;
    el.cash.innerHTML = rows
      .map(
        ([label, r, note]) => `
          <li>
            <span>${esc(label)}<small>${esc(note)}</small></span>
            <strong>${esc(amount(r))}</strong>
          </li>
        `
      )
      .join("") +
      `<li class="is-total"><span>준비 권장 (최대치 올림)<small>약 ${esc(formatManwon(recommended * money.rate))} · ${esc(money.fx.title)}</small></span><strong>${esc(money.format([recommended, recommended]))}</strong></li>`;
  }

  function renderCityCards(results) {
    const cheapest = cheapestCityId(results);
    const card = (cityId) => {
      const city = cities[cityId];
      const r = results[cityId];
      const active = cityId === state.cityId;
      const badge = cityId === cheapest ? `<span class="badge">최저</span>` : "";
      const month = perRxMonth(r);
      const monthText = month ? `<small>처방 1개월분당 약 ${formatManwon(month.mean)}</small>` : "";
      return `
        <button type="button" class="card-btn city-card ${active ? "active" : ""}" data-id="${esc(cityId)}" aria-pressed="${active}">
          <span class="title">${esc(city.name)} ${badge}</span>
          <span class="sub">${esc(city.subtitle)} · ${esc(city.flightTime)}</span>
          <span class="price">약 ${formatManwon(r.perPerson.mean)} <small>${formatBand(r.perPerson.band)} / 1인</small>${monthText}</span>
        </button>
      `;
    };
    el.city.innerHTML = Object.values(countries)
      .map((country) => {
        const ids = cityOrder.filter((cityId) => cities[cityId].country === country.id);
        return `
          <p class="group-label">${esc(country.name)} · ${esc(country.routeNote)}</p>
          <div class="card-grid card-grid-city">${ids.map(card).join("")}</div>
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

  function renderCards(container, list, selectedId, subtitleFn, deltaFn) {
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
        const deltaValue = !active && deltaFn ? deltaFn(item) : 0;
        const deltaText = formatDelta(deltaValue);
        const delta = deltaText ? `<span class="delta ${deltaValue > 0 ? "is-up" : "is-down"}">${esc(deltaText)}</span>` : "";
        return `
          <button type="button" class="card-btn ${active ? "active" : ""}" data-id="${esc(item.id)}" aria-pressed="${active}">
            <span class="title">${esc(item.title)}</span>
            ${subtitle}
            ${delta}
          </button>
        `;
      })
      .join("");
  }

  function renderActivityControls(city, s, money) {
    const season = currentSeason();
    el.activityControls.innerHTML = city.activities
      .map((act) => {
        const priceText = describeActivityPrice(act, season, money);
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
    set("summary-schedule", `${currentDeparture().title} · ${currentDuration().title} · ${currentSeason().title}`);
    set("summary-fx", result.money.fx.title);
    set("summary-rx", `${planTitle(result.rxPlan, result.country)} · ${result.rxPatients}명 · Day${result.preNights + 1}`);
    set("summary-clinic", result.clinic.short);
    set("summary-stayPre", result.preNights ? titleOf(city.staysPre, s.stayPreId) : "없음 (도착일 처방)");
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
    el.toggleAll.textContent = Object.values(state.ui.accordion).some(Boolean) ? "모두 접기" : "모두 펼치기";
  }

  function renderResult(city, result) {
    const dates = `${formatDate(result.startDate)}–${formatDate(addDays(result.startDate, result.nights))}`;
    el.resultContext.textContent = `${city.name} · ${currentDuration().title} · ${dates} · 연차 ${result.leaveDays}일`;
    const pp = result.perPerson;
    el.perPersonTotal.textContent = `약 ${formatManwon(pp.mean)} / 1인`;
    el.perPersonBand.innerHTML = `80% 범위 ${esc(formatBand(pp.band))}<span class="band-extreme"> · 항목 단순 합산 ${esc(formatBand(pp.extreme))}</span>`;
    el.groupTotal.textContent = `총액 약 ${formatManwon(result.total.mean)} (${formatBand(result.total.band)}) · ${result.people}명 · ${result.money.fx.title}`;
    const month = perRxMonth(result);
    el.perMonth.hidden = !month;
    if (month) {
      el.perMonth.innerHTML = `처방 1개월분당 <strong>약 ${esc(formatManwon(month.mean))}</strong> (${esc(formatBand(month.band))})<small>${result.people}명 여행 총액 ÷ ${esc(formatMonths(month.months))} · 그중 약값·진료비 ${esc(formatManwon(month.drug))}</small>`;
    }

    const b = result.breakdown;
    const savingsText = result.rxSavings > 0 ? ` · 국내 처방보다 약 ${formatManwon(result.rxSavings)} 저렴` : "";
    const rows = [
      ["마운자로 처방", b.rx, `${result.clinic.short} · ${planTitle(result.rxPlan, result.country)} × ${result.rxPatients}명${savingsText}`],
      ["항공", b.flight, result.flightNote],
      ["숙박", b.stay, result.stayNote],
      ["숙박세·입탕세", b.stayTax, "1인 1박 기준, 현장 결제"],
      ["식비", b.meal, `${result.mealDays}일 기준`],
      ["공항 이동", b.airport, titleOf(airportOptionsFor(city, findById(city.flights, cityState().flightId)), cityState().airportId)],
      ["시내 교통", b.transport, titleOf(city.transports, cityState().transportId)],
      ["근교 이동", b.excursion, result.stayB ? `${result.stayB.short || result.stayB.title} 왕복` : ""],
      ["액티비티", b.activities, ""],
      ["예비비", b.contingency, `예상 합계의 ${pct(calculationRules.contingencyRate)} · 범위에 영향 없음`],
    ].filter(([label, line]) => (label !== "근교 이동" && label !== "숙박세·입탕세") || line.hi > 0);

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
        const month = perRxMonth(r);
        const picks = [
          r.clinic.short,
          planTitle(r.rxPlan, r.country),
          titleOf(city.flights, s.flightId).split(" · ")[0],
          `${r.preNights ? `${r.stayPre.short} → ` : ""}${shortTitle(titleOf(city.staysA, s.stayAId))}`,
          r.fullDayLabels.length ? r.fullDayLabels.join(" + ") : "",
        ]
          .filter(Boolean)
          .join(" · ");
        return `
          <tr class="${active ? "is-active" : ""}">
            <th scope="row">
              <button type="button" class="link-btn" data-city="${esc(cityId)}" aria-pressed="${active}">${esc(city.name)}</button>
              ${cityId === cheapest ? `<span class="badge">최저</span>` : ""}
              <small>${esc(picks)}</small>
            </th>
            <td><strong>${formatManwon(r.perPerson.mean)}</strong><small>${formatBand(r.perPerson.band)}</small></td>
            <td>${month ? `<strong>${formatManwon(month.mean)}</strong><small>${esc(formatMonths(month.months))}</small>` : "-"}</td>
            <td>${formatManwon(r.total.mean)}<small>${formatBand(r.total.band)}</small></td>
          </tr>
        `;
      })
      .join("");
  }

  function renderTimeline(plan, warnings) {
    const itemsHtml = (items) => `<span class="day-items">${items.map((item) => `<span>${esc(item)}</span>`).join("")}</span>`;
    const pre = plan.preTrip.length
      ? `<li class="is-pre"><strong>출발 전</strong>${itemsHtml(plan.preTrip)}</li>`
      : "";
    el.timeline.innerHTML =
      pre +
      plan.days
        .map(
          (day, index) => `
          <li class="${day.rx ? "is-rx" : ""}">
            <strong>Day${index + 1}</strong> <span class="day-date">${esc(formatDate(day.date))}</span>${day.night ? `<span class="day-night">${esc(day.night)} 숙박</span>` : ""}
            ${itemsHtml(day.items)}
          </li>
        `
        )
        .join("");

    el.timelineWarning.hidden = !warnings.length;
    el.timelineWarning.innerHTML = warnings.map((warning) => esc(warning.text)).join("<br />");
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
    const checkoutPre = result.checkoutPre;
    const checkoutA = result.checkoutA;
    const stayA = findById(city.staysA, s.stayAId);
    const stayPre = result.stayPre;
    const roomConfig = findById(data.roomConfigs, s.roomConfigId);
    const money = result.money;
    const roomType = (stay) => {
      if (money.of(stay, "perUnitPerNight")) return "2룸(침실 2개)";
      if (money.of(stay, "perPersonPerNight")) return `${roomConfig.occupancy}인 1실`;
      return roomConfig.occupancy === 2 ? "트윈(침대 2개)" : roomConfig.title;
    };
    const unitWord = (stay) => (money.of(stay, "perUnitPerNight") ? "채" : "실");
    const departureTime = currentDeparture().arrival === "night" ? "저녁 출발" : "오전 출발";
    const origin = flight.from || "ICN";
    const flightQuery = `Flights from ${origin} to ${flight.airport} on ${start} through ${end}`;

    const slots = {
      flight: {
        label: `항공권 · ${origin}→${flight.airport} ${formatDate(start)}–${formatDate(end)}`,
        sub: `Google Flights · ${flight.title} · 첫날 ${departureTime} 편으로 고르기`,
        href: `https://www.google.com/travel/flights?hl=ko&curr=KRW&q=${encodeURIComponent(flightQuery)}`,
      },
      stayPre: result.preNights
        ? {
            label: `처방 전 · ${stayPre.title} ${formatDate(start)}–${formatDate(checkoutPre)}`,
            sub: `Booking.com · ${money.of(stayPre, "perBedPerNight") ? `${result.people}침대 (남녀 구역 확인)` : `개인실 ${result.roomsPre}실`}`,
            href: bookingUrl(stayPre.booking || city.bookingCity, start, checkoutPre, result.roomsPre),
          }
        : null,
      stayA: {
        label: `처방 후 · ${stayA.title} ${formatDate(checkoutPre)}–${formatDate(checkoutA)}`,
        sub: `Booking.com · ${roomType(stayA)} ${result.roomsA}${unitWord(stayA)} · 객실 냉장고 확인`,
        href: bookingUrl(stayA.booking || city.bookingCity, checkoutPre, checkoutA, result.roomsA),
      },
      stayB: result.stayB
        ? {
            label: `B숙소 · ${result.stayB.title} ${formatDate(checkoutA)}–${formatDate(end)}`,
            sub: `Booking.com · ${roomType(result.stayB)} ${result.roomsB}${unitWord(result.stayB)}`,
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
    const country = result.country;
    const notes = [...(rx.notes || []), ...(country.rxNotes || []), ...(forCountry(currentSeason(), country).notes || []), ...(city.notes || [])];
    Object.entries(city.dateNotes || {}).forEach(([iso, text]) => {
      if (iso >= result.startDate && iso <= addDays(result.startDate, result.nights)) notes.push(text);
    });
    const roomConfig = findById(data.roomConfigs, s.roomConfigId);
    notes.push(`숙박은 평일가에 1박마다 날짜 배율을 곱합니다 (이번 일정 ${result.nightFactorText}).`);
    if (result.usesUnits) {
      notes.push("2룸 레지던스는 객실 구성과 무관하게 4인당 1채(침실 2개, 침실마다 트윈)로 계산합니다. 침대 구성을 꼭 확인하세요.");
    }
    if (roomConfig.occupancy === 2 && !result.usesUnits) {
      notes.push(country.twinNote);
      notes.push("트윈이 없거나 마감이면 2룸(1인 1실 2개)으로 잡으세요. 비용은 '1인 1실' 카드로 비교할 수 있습니다.");
    }
    if (roomConfig.occupancy === 1) {
      notes.push(country.singleNote);
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
    const groups = [{ title: "공통 (마운자로 반입·가격·보관, 계산 방식·환율·숙박세·시기·객실·식비)", items: collectShared() }];
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
    const items = [...(rx.sourceRefs || []), ...(data.meta.sharedSources || [])];
    const shared = [calculationRules, ...data.departures, ...data.seasons, ...data.roomConfigs, ...data.mealLevels];
    Object.values(currencies).forEach((currency) => shared.push(...currency.fxOptions));
    Object.values(countries).forEach((country) => {
      items.push(...(country.sourceRefs || []));
      shared.push(country.lodgingCalendar);
    });
    shared.forEach((item) => {
      if (item.sourceRef) items.push(item.sourceRef);
      // Per-country overrides of a shared card bring their own source.
      Object.keys(countries).forEach((countryId) => {
        if (item[countryId] && item[countryId].sourceRef) items.push(item[countryId].sourceRef);
      });
    });
    return items;
  }

  function collectCitySources(city) {
    const items = [];
    [city.clinics, city.flights, city.airportTransfers, city.staysPre, city.staysA, city.staysB, city.transports, city.activities].forEach((list) => {
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
    const country = countryOf(city);
    const money = moneyFor(city);
    const s = state.cities[cityId];
    const people = state.travelers;
    const nights = currentDuration().nights;
    const days = nights + 1;
    const season = forCountry(currentSeason(), country);
    const departure = currentDeparture();
    const fx = money.rate;
    const peak = season.parkTier === "peak";

    const flight = findById(city.flights, s.flightId);
    const airport = findById(airportOptionsFor(city, flight), s.airportId) || airportOptionsFor(city, flight)[0];
    const roomConfig = forCountry(findById(data.roomConfigs, s.roomConfigId), country);
    const stayPre = findById(city.staysPre, s.stayPreId) || city.staysPre[0];
    const stayA = findById(city.staysA, s.stayAId);
    const stayBRaw = findById(city.staysB, s.stayBId);
    const stayBWanted = stayBRaw && stayBRaw.id !== "none" ? stayBRaw : null;
    const meal = findById(data.mealLevels, s.mealId);
    const transport = findById(city.transports, s.transportId);
    const clinic = findById(city.clinics, s.clinicId) || city.clinics[0];
    const rxPlan = rxPlanFor(country);
    const rxPatients = clamp(state.rxPatients, rx.patients.min, people);

    // Prescription day splits the nights: before = budget beds, from that night on = 2-person rooms.
    // A night arrival cannot see a doctor on Day1, and at least one night must follow the prescription.
    const rxDay = currentRxDay();
    const rxAdjust = [];
    let preNights = rxDay.dayIndex;
    if (preNights === 0 && departure.arrival === "night") {
      preNights = 1;
      rxAdjust.push({ scopes: ["rx"], conflict: true, text: "밤 도착이라 Day1 처방은 안 돼서 Day2 처방으로 계산했습니다." });
    }
    if (preNights > nights - 1) {
      preNights = nights - 1;
      rxAdjust.push({ scopes: ["rx"], conflict: true, text: `처방 뒤 1박은 있어야 해서 Day${preNights + 1} 처방으로 당겼습니다.` });
    }
    const postNights = nights - preNights;
    const stayB = stayBWanted && postNights >= 2 ? stayBWanted : null;
    if (stayBWanted && !stayB) {
      rxAdjust.push({
        scopes: ["stayB"],
        conflict: true,
        text: `처방 후 숙박이 1박뿐이라 B숙소(${stayBWanted.short || stayBWanted.title})는 빼고 계산했습니다.`,
      });
    }
    const nightsA = postNights - (stayB ? 1 : 0);

    const start = addDays(season.startDate, Number(departure.startOffset || 0));
    const end = addDays(start, nights);
    const checkoutPre = addDays(start, preNights);
    const checkoutA = addDays(checkoutPre, nightsA);
    // Every line is an estimate {lo, hi, mean, var} in KRW; [lo, hi] is read as that line's P10-P90.
    const fromLocal = (r, factor = 1) => estimate(r, fx * factor);
    const local = (item, key) => money.of(item, key) || [0, 0];

    // Stays: weekday card price × each night's calendar factor
    const calendar = country.lodgingCalendar;
    const factorsPre = nightFactors(calendar, start, preNights);
    const factorsA = nightFactors(calendar, checkoutPre, nightsA);
    const factorsB = stayB ? nightFactors(calendar, checkoutA, 1) : [];
    const stayPreInfo = preStayCost(stayPre, people, factorsPre, money);
    const stayAInfo = stayCost(stayA, roomConfig, people, factorsA, money);
    const stayBInfo = stayB ? stayCost(stayB, roomConfig, people, factorsB, money) : emptyStay();

    // Quotes typed from the live links replace the estimate while their conditions still match.
    const roomsLabel = (info) => `${info.rooms}${info.usesUnits ? "채" : info.kind === "bed" ? "침대" : "실"}`;
    const quoteKeys = {
      flight: [flight.id, start, end].join("|"),
      stayPre: preNights ? [stayPre.id, start, checkoutPre, stayPreInfo.kind, stayPreInfo.rooms, people].join("|") : null,
      stayA: [stayA.id, checkoutPre, checkoutA, stayAInfo.kind, stayAInfo.rooms, people].join("|"),
      stayB: stayB ? [stayB.id, checkoutA, end, stayBInfo.kind, stayBInfo.rooms, people].join("|") : null,
    };
    const quoteContext = {
      flight: `${flight.title} ${formatDate(start)}–${formatDate(end)}`,
      stayPre: preNights ? `${shortTitle(stayPre.title)} ${formatDate(start)}–${formatDate(checkoutPre)} · ${people}명 ${roomsLabel(stayPreInfo)}` : "",
      stayA: `${shortTitle(stayA.title)} ${formatDate(checkoutPre)}–${formatDate(checkoutA)} · ${people}명 ${roomsLabel(stayAInfo)}`,
      stayB: stayB ? `${shortTitle(stayB.title)} ${formatDate(checkoutA)}–${formatDate(end)} · ${people}명 ${roomsLabel(stayBInfo)}` : "",
    };
    const quotes = s.quotes || {};
    const quoteStatus = {};
    Object.keys(quoteKeys).forEach((field) => {
      const quote = quotes[field];
      quoteStatus[field] = !quote || !quoteKeys[field] ? "none" : quote.key === quoteKeys[field] ? "applied" : "stale";
    });
    const applied = (field) => quoteStatus[field] === "applied";

    const flightPerPerson = scale(flight.priceKRW, season.flightFactor * Number(departure.flightFactor || 1));
    const estimates = {
      flight: flightPerPerson,
      stayPre: preNights ? scale(stayPreInfo.cost, fx) : null,
      stayA: scale(stayAInfo.cost, fx),
      stayB: stayB ? scale(stayBInfo.cost, fx) : null,
    };

    // Flight (KRW)
    const flightLine = applied("flight") ? exact(quotes.flight.krw * people, true) : estimate(flightPerPerson, people);

    // Stays
    const stayPreLine = !preNights ? exact(0) : applied("stayPre") ? exact(quotes.stayPre.krw, true) : estimate(estimates.stayPre);
    const stayALine = applied("stayA") ? exact(quotes.stayA.krw, true) : estimate(estimates.stayA);
    const stayBLine = !stayB ? exact(0) : applied("stayB") ? exact(quotes.stayB.krw, true) : estimate(estimates.stayB);
    const stayLine = sumLines(stayPreLine, stayALine, stayBLine);
    const stayParts = [preNights ? stayPreLine : null, stayALine, stayB ? stayBLine : null].filter(Boolean);
    stayLine.locked = stayParts.every((line) => line.locked);
    stayLine.partial = !stayLine.locked && stayParts.some((line) => line.locked);

    // Lodging / bathing tax (per person per night)
    const taxLocal = sumRanges(
      scale(local(stayPre, "lodgingTax"), people * preNights),
      scale(local(stayA, "lodgingTax"), people * nightsA),
      stayB ? scale(local(stayB, "stayTax"), people) : [0, 0]
    );
    const stayTaxLine = fromLocal(taxLocal);

    // Mounjaro: drug by weeks + per-patient fees and cold shipping
    const rxPerPatient = sumRanges(rxDrugCost(clinic, rxPlan, money), local(clinic, "fee"), local(clinic, "ship"));
    const rxLocal = scale(rxPerPatient, rxPatients);
    const rxLine = fromLocal(rxLocal);
    const koreaKRW = sumRanges(
      ...Object.entries(rxPlan.weeks).map(([dose, weeks]) => scale((rx.koreaPer4KRW || {})[dose] || [0, 0], (weeks / 4) * rxPatients))
    );
    const rxSavings = (koreaKRW[0] + koreaKRW[1]) / 2 - rxLine.mean;

    // Meals
    const mealDays = days - (stayB && stayB.includesMeals ? Number(calculationRules.ryokanMealCredit || 0) : 0);
    const mealLine = fromLocal(local(meal, "perPersonPerDay"), people * mealDays * Number(city.mealFactor ?? 1));

    // City transport (per day on nights count; arrival/departure days are covered by airport transfer)
    const groupOnce = money.of(transport, "perGroupOnce");
    const transportLine = sumLines(
      fromLocal(local(transport, "perPersonPerDay"), people * nights),
      groupOnce ? fromLocal(groupOnce, Math.ceil(people / 9)) : exact(0)
    );

    // Airport transfer, excursion to stay B
    const airportLine = fromLocal(transferCost(airport, people, money));
    const excursionLine = stayB ? fromLocal(local(stayB, "transferPerPerson"), people) : exact(0);

    // Activities: each ticket is its own estimate
    const activityLines = [];
    const fullDayLabels = [];
    let cashActivities = [0, 0];
    city.activities.forEach((act) => {
      const value = s.activities[act.id];
      let qty = act.kind === "toggle" ? (value ? 1 : 0) : Number(value || 0);
      if (act.perUnitOf) qty = qty ? Number(s.activities[act.perUnitOf] || 0) : 0;
      if (qty <= 0) return;

      if (act.slot === "full") fullDayLabels.push(qty > 1 ? `${shortTitle(act.title)} ×${qty}` : shortTitle(act.title));

      const groupPrice = money.of(act, "group");
      if (groupPrice) {
        activityLines.push(fromLocal(groupPrice, qty));
        return;
      }
      const price = activityPrice(act, peak, money);
      activityLines.push(fromLocal(price, people * qty));
      if (act.cash) cashActivities = sumRanges(cashActivities, scale(price, people * qty));
    });

    // Local cash to carry: places that may refuse foreign cards or take cash only
    const deposit = Number(money.of(clinic, "deposit") || 0) * rxPatients;
    const cashRx =
      clinic.cashPart === "none" ? [0, 0]
      : clinic.cashPart === "ship" ? scale(local(clinic, "ship"), rxPatients)
      : [Math.max(0, rxLocal[0] - deposit), Math.max(0, rxLocal[1] - deposit)];
    const cash = {
      rx: cashRx,
      tax: taxLocal,
      activities: cashActivities,
      buffer: scale(money.currency.cashBuffer, people),
    };
    cash.total = sumRanges(cash.rx, cash.tax, cash.activities, cash.buffer);

    const breakdown = {
      rx: rxLine,
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
    // The drug price is fixed by the clinic, so the contingency covers travel costs only.
    const contingency = (subtotal.mean - rxLine.mean) * Number(calculationRules.contingencyRate || 0);
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
    const preSummary = preNights ? `${stayPre.short} ${roomsLabel(stayPreInfo)} × ${preNights}박 → ` : "";
    const fullSummary = `${preSummary}${roomSummary}${stayB ? ` + ${stayB.short || "B숙소"} 1박` : ""}`;
    const allFactors = [...factorsPre, ...factorsA, ...factorsB];
    const nightFactorText = allFactors.map((factor, i) => `${formatDate(addDays(start, i))} ×${factor.toFixed(2).replace(/0$/, "")}`).join(", ");

    return {
      cityId,
      country,
      money,
      people,
      nights,
      preNights,
      nightsA,
      startDate: start,
      checkoutPre,
      checkoutA,
      stayPre,
      stayA,
      stayB,
      clinic,
      rxPlan,
      rxPatients,
      rxSavings,
      rxAdjust,
      cash,
      leaveDays: countLeaveDays(start, nights, departure),
      roomsPre: stayPreInfo.rooms,
      roomsA: stayAInfo.rooms,
      roomsB: stayBInfo.rooms,
      usesUnits: stayAInfo.usesUnits || stayBInfo.usesUnits,
      roomSummary: fullSummary,
      stayNote: fullSummary,
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

  function nightFactors(calendar, startIso, count) {
    return Array.from({ length: Math.max(0, count) }, (_, i) => {
      const iso = addDays(startIso, i);
      const special = calendar.dates ? Number(calendar.dates[iso]) : NaN;
      if (Number.isFinite(special)) return special;
      const weekday = Number((calendar.weekday || [])[weekdayOf(iso)]);
      return Number.isFinite(weekday) ? weekday : 1;
    });
  }

  function transferCost(option, people, money) {
    const perVehicle = money.of(option, "perVehicleRoundtrip");
    if (perVehicle) {
      return scale(perVehicle, Math.ceil(people / Number(option.vehicleCapacity || 4)));
    }
    return scale(money.of(option, "perPersonRoundtrip") || [0, 0], people);
  }

  function roomCountFor(roomConfig, people) {
    return Math.ceil(people / Math.max(1, Number(roomConfig.occupancy || 2)));
  }

  function emptyStay() {
    return { cost: [0, 0], rooms: 0, kind: "none", usesUnits: false };
  }

  // Budget beds before the prescription: capsule/dorm are priced per bed, a guesthouse private room per room.
  function preStayCost(stay, people, factors, money) {
    if (!stay || !factors.length) return emptyStay();
    const nightUnits = sum(factors);
    const perBed = money.of(stay, "perBedPerNight");
    if (perBed) {
      return { cost: scale(perBed, people * nightUnits), rooms: people, kind: "bed", usesUnits: false };
    }
    const rooms = Math.ceil(people / Math.max(1, Number(stay.roomCapacity || 2)));
    return { cost: scale(money.of(stay, "perRoomPerNight"), rooms * nightUnits), rooms, kind: "room", usesUnits: false };
  }

  // One patient's drug price for a plan, in local currency: each dose's 4-week price scaled by its weeks.
  function rxDrugCost(clinic, plan, money) {
    const per4 = money.of(clinic, "per4") || {};
    return sumRanges(...Object.entries(plan.weeks).map(([dose, weeks]) => (weeks ? scale(per4[dose] || [0, 0], weeks / 4) : [0, 0])));
  }

  // Japan sells single-dose pens (1 pen = 1 week, named by the dose); China sells a 4-dose pen
  // (1 pen = 4 weeks, named by its total content: the "40mg" pen gives 10mg a week).
  function planTitle(plan, country) {
    return Object.entries(plan.weeks)
      .filter(([, weeks]) => weeks)
      .map(([dose, weeks]) => `${country.doseLabel[dose]} ${weeks / country.weeksPerPen}펜`)
      .join(" + ");
  }

  // Months of medicine the trip brings home (4 weeks = 1 month, all patients together).
  function rxMonths(result) {
    return (Object.values(result.rxPlan.weeks).reduce((sum, weeks) => sum + weeks, 0) / 4) * result.rxPatients;
  }

  // Whole-trip cost (everyone travelling) per month of medicine, and the drug alone per month.
  // This puts plans of different sizes, and Japan (12 weeks) against China (24 weeks), on one scale.
  function perRxMonth(result) {
    const months = rxMonths(result);
    if (!months) return null;
    return {
      months,
      mean: result.total.mean / months,
      band: scale(result.total.band, 1 / months),
      drug: result.breakdown.rx.mean / months,
    };
  }

  function formatMonths(months) {
    return `${months.toLocaleString("ko-KR", { maximumFractionDigits: 1 })}개월분`;
  }

  // Customs allows 6 containers, or more than 6 when that is still within 3 months of use.
  function importLimitPens(country) {
    return Math.max(rx.importBaseUnits, rx.importLimitWeeks / country.weeksPerPen);
  }

  // When to arrange the prescription. A clinic can describe its own step (book); otherwise it is a morning visit that day.
  function bookingStep(clinic, rxDate, planText) {
    if (clinic.book) {
      return {
        when: `${formatDate(addDays(rxDate, -clinic.book.daysBefore))}쯤`,
        text: clinic.book.text.replaceAll("{rx}", formatDate(rxDate)),
      };
    }
    return { when: formatDate(rxDate), text: `${clinic.hours} 중 오전 진료 예약 · ${planText} 재고 확인` };
  }

  // Weekdays (Mon-Fri) spent away from work; a departure after work does not cost its first day.
  function countLeaveDays(start, nights, departure) {
    let count = 0;
    for (let i = 0; i <= nights; i += 1) {
      const wd = weekdayOf(addDays(start, i));
      if (wd === 0 || wd === 6) continue;
      if (i === 0 && departure.workFirstDay) continue;
      count += 1;
    }
    return count;
  }

  // factors: one calendar multiplier per night (weekday card price = 1.0)
  function stayCost(stay, roomConfig, people, factors, money) {
    if (!factors.length) return emptyStay();
    const nightUnits = sum(factors);

    // Ryokan: per-person price, adjusted by how many share a room (solo use costs more).
    const perPerson = money.of(stay, "perPersonPerNight");
    if (perPerson) {
      const rooms = roomCountFor(roomConfig, people);
      const factor = Number(roomConfig.perPersonFactor ?? 1);
      return { cost: scale(perPerson, people * nightUnits * factor), rooms, kind: roomConfig.id, usesUnits: false };
    }

    // Apartment: fixed price per unit, room config does not apply.
    const perUnit = money.of(stay, "perUnitPerNight");
    if (perUnit) {
      const rooms = Math.ceil(people / Number(stay.unitCapacity || 4));
      return { cost: scale(perUnit, rooms * nightUnits), rooms, kind: "unit", usesUnits: true };
    }

    // Hotel: card price is a twin room; occupancy changes room count and per-room price.
    const rooms = roomCountFor(roomConfig, people);
    const factor = Number(roomConfig.priceFactor ?? 1);
    return { cost: scale(money.of(stay, "perRoomPerNight"), rooms * nightUnits * factor), rooms, kind: roomConfig.id, usesUnits: false };
  }

  // ---------- Timeline ----------
  function buildTimeline(city, s, result) {
    const nights = result.nights;
    const dayCount = nights + 1;
    const last = dayCount - 1;
    const departure = currentDeparture();
    const flight = findById(city.flights, s.flightId);
    const airport = findById(airportOptionsFor(city, flight), s.airportId);
    const airportLabel = airport ? airport.short || airport.title : "공항 이동";
    const clinic = result.clinic;
    const country = result.country;
    const planText = planTitle(result.rxPlan, country);
    const rxIdx = result.preNights;
    const preShort = result.stayPre.short;
    const postShort = shortTitle(result.stayA.title);
    const morningArrival = departure.arrival === "morning";
    const warnings = [...result.rxAdjust];
    const overflow = [];

    const days = Array.from({ length: dayCount }, (_, i) => {
      const date = addDays(result.startDate, i);
      let night = "";
      if (i < rxIdx) night = preShort;
      else if (i < rxIdx + result.nightsA) night = postShort;
      else if (i < nights) night = result.stayB ? result.stayB.short || "B숙소" : postShort;
      return {
        date,
        wd: weekdayOf(date),
        kind: "open",
        rx: i === rxIdx,
        night,
        main: null,
        cap: 2,
        halves: [],
        morning: null,
        lunch: null,
        evenings: [],
        morningOk: true,
        lunchOk: true,
        eveningOk: true,
      };
    });

    const arrivalDay = days[0];
    arrivalDay.kind = "arrival";
    arrivalDay.cap = morningArrival ? 1 : 0;
    arrivalDay.morningOk = false;
    arrivalDay.lunchOk = morningArrival;
    arrivalDay.eveningOk = morningArrival;

    const departureDay = days[last];
    departureDay.kind = "departure";
    departureDay.cap = 0;
    departureDay.morningOk = Boolean(city.departureLunchOk);
    departureDay.lunchOk = Boolean(city.departureLunchOk);
    departureDay.eveningOk = false;

    const bDay = result.stayB ? last - 1 : -1;
    if (bDay > 0) {
      days[bDay].kind = "toB";
      days[bDay].cap = 1;
      days[bDay].eveningOk = false;
    }
    // The prescription morning leaves room for one more half-day item.
    if (rxIdx > 0 && days[rxIdx].kind === "open") {
      days[rxIdx].kind = "rx";
      days[rxIdx].cap = 1;
    }

    // Prescription day checks
    const rxDate = days[rxIdx].date;
    const rxWd = weekdayOf(rxDate);
    // conflict = the plan does not work as picked; the others are things to check when booking.
    if (!clinic.openDays.includes(rxWd)) {
      warnings.push({
        scopes: ["rx", "clinic"],
        conflict: true,
        text: `${withTopic(clinic.short)} ${WEEKDAYS[rxWd]}요일 휴무라 ${formatDate(rxDate)} 처방이 안 됩니다. 처방일이나 클리닉을 바꾸세요.`,
      });
    }
    if (clinic.irregular) {
      warnings.push({
        scopes: ["clinic"],
        conflict: false,
        text: `${withTopic(clinic.short)} 부정기 휴무가 있습니다. ${formatDate(rxDate)} 진료 가능 여부를 예약 때 확인하세요.`,
      });
    }
    if (clinic.weekendNote && (rxWd === 0 || rxWd === 6)) {
      warnings.push({ scopes: ["clinic"], conflict: false, text: `${formatDate(rxDate)}은 주말이라 ${clinic.weekendNote}` });
    }
    if (clinic.eve && rxIdx === 0) {
      warnings.push({
        scopes: ["rx", "clinic"],
        conflict: true,
        text: `${withTopic(clinic.short)} 전날 주문해야 해서 도착일(Day1) 수령이 안 됩니다. 처방일을 Day2 이후로 바꾸세요.`,
      });
    }
    if (clinic.eveLateNote && rxIdx === 1 && !morningArrival) {
      warnings.push({ scopes: ["rx", "clinic"], conflict: false, text: clinic.eveLateNote });
    }
    const planWeeks = sum(Object.values(result.rxPlan.weeks));
    if (clinic.usualMaxWeeks && planWeeks > clinic.usualMaxWeeks) {
      warnings.push({
        scopes: ["rx", "clinic"],
        conflict: false,
        text: `${withTopic(clinic.short)} 한 번에 보통 ${clinic.usualMaxWeeks}주분까지 나옵니다. ${planText}(${planWeeks}주분)은 다 안 나올 수 있으니 미리 문의하세요.`,
      });
    }

    const activityQueue = (slot) => {
      const list = [];
      city.activities.forEach((act) => {
        if (act.slot !== slot) return;
        const value = s.activities[act.id];
        const qty = act.kind === "toggle" ? (value ? 1 : 0) : Number(value || 0);
        for (let i = 0; i < qty; i += 1) {
          list.push({ act, label: qty > 1 && slot === "full" ? `${act.timeline} (${i + 1}일차)` : act.timeline });
        }
      });
      // Items limited to certain weekdays are placed first so they get the days they can use.
      return list.sort((a, b) => Number(Boolean(b.act.allowedDays)) - Number(Boolean(a.act.allowedDays)));
    };
    const allowed = (act, day) => !act.allowedDays || act.allowedDays.includes(day.wd);
    const missReason = (act) => {
      if (!act.allowedDays || days.some((day) => allowed(act, day))) return "";
      const weekdayOnly = !act.allowedDays.includes(0) && !act.allowedDays.includes(6);
      return weekdayOnly ? " (일정에 평일 낮이 없음)" : " (휴무일과 겹침)";
    };
    const place = (item, candidates, assign) => {
      const target = candidates.find((day) => allowed(item.act, day));
      if (target) assign(target);
      else overflow.push(`${item.label}${missReason(item.act)}`);
    };

    // Full-day trips take a free day
    activityQueue("full").forEach((item) => {
      place(item, days.filter((day) => day.kind === "open" && !day.main), (day) => {
        day.main = item.label;
        day.kind = "full";
        day.cap = 0;
        day.lunchOk = false;
      });
    });
    let freeIndex = 0;
    days
      .filter((day) => day.kind === "open")
      .forEach((day) => {
        day.main = city.freeDays[freeIndex % city.freeDays.length];
        freeIndex += 1;
      });

    // Half-day items: the least-loaded day with room
    activityQueue("half").forEach((item) => {
      const candidates = days
        .filter((day) => day.halves.length < day.cap && allowed(item.act, day))
        .sort((a, b) => a.halves.length / a.cap - b.halves.length / b.cap);
      place(item, candidates, (day) => day.halves.push(item.label));
    });
    activityQueue("morning").forEach((item) => {
      place(item, days.filter((day) => day.morningOk && !day.morning), (day) => {
        day.morning = item.label;
      });
    });
    activityQueue("lunch").forEach((item) => {
      place(item, days.filter((day) => day.lunchOk && !day.lunch), (day) => {
        day.lunch = item.label;
      });
    });
    activityQueue("evening").forEach((item) => {
      const candidates = days.filter((day) => day.eveningOk).sort((a, b) => a.evenings.length - b.evenings.length);
      place(item, candidates, (day) => day.evenings.push(`저녁 ${item.label}`));
    });
    // A delivery route is ordered the evening before it arrives.
    if (clinic.eve && rxIdx > 0) days[rxIdx - 1].evenings.push(clinic.eve);

    const rxSteps = (arrivedToday) => {
      const steps = [];
      if (!arrivedToday && rxIdx > 0) steps.push(`${preShort} 체크아웃 → ${country.luggageRxDay}`);
      steps.push(`처방 · ${clinic.action}`);
      steps.push(`${postShort} 체크인 · 펜은 객실 냉장고에`);
      return steps;
    };

    days.forEach((day) => {
      const items = [];
      if (day.morning) items.push(day.morning);
      if (day.kind === "arrival") {
        const when = morningArrival ? "오전" : "밤";
        if (day.rx) {
          items.push(`${when} ${flight.airport} 도착 → ${airportLabel}`);
          items.push(...rxSteps(true));
        } else {
          items.push(`${when} ${flight.airport} 도착 → ${airportLabel} → ${day.night} 체크인`);
        }
      } else if (day.kind === "departure") {
        const checkout = `${result.stayB ? result.stayB.short || "B숙소" : postShort} 체크아웃`;
        if (day.lunch) {
          items.push(`${checkout} · ${country.luggageLastDay}`, day.lunch);
          day.lunch = null;
          items.push(`${airportLabel} → 귀국 (펜은 기내 휴대)`);
        } else {
          items.push(`${checkout} → ${airportLabel} → 귀국 (펜은 기내 휴대)`);
        }
      } else if (day.kind === "rx") {
        items.push(...rxSteps(false));
      } else if (day.kind === "toB") {
        if (!day.halves.length) items.push("오전 시내 자유");
      } else if (day.main) {
        items.push(day.main);
      }
      items.push(...day.halves);
      if (day.lunch) items.push(day.lunch);
      if (day.kind === "toB") items.push(`오후 ${result.stayB.short || "B숙소"} 이동 · ${result.stayB.includesMeals ? "온천·석식" : "체크인"}`);
      items.push(...day.evenings);
      day.items = items;
    });

    const preTrip = [];
    if (clinic.book) {
      const booking = bookingStep(clinic, rxDate, planText);
      preTrip.push(`${booking.when} ${booking.text}`);
    } else {
      preTrip.push(`${clinic.short} ${formatDate(rxDate)} 오전 진료 예약 · ${planText} 재고 확인`);
    }
    const money = result.money;
    const cashToCarry = roundUp(result.cash.total[1], money.currency.cashStep);
    preTrip.push(`${money.currency.name} 현금 약 ${money.format([cashToCarry, cashToCarry])} 준비 ('처방 준비' 탭에 내역)`);

    return { days, overflow, warnings, preTrip };
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

  function currentDeparture() {
    return findById(data.departures, state.departureId) || data.departures[0];
  }

  function rxPlanFor(country) {
    return findById(country.rxPlans, state.rxPlan[country.id]) || country.rxPlans[0];
  }

  function currentRxDay() {
    return findById(rx.days, state.rxDayId) || rx.days[0];
  }

  function currentSeason() {
    return findById(data.seasons, state.seasonId) || data.seasons[0];
  }

  function countryOf(city) {
    return countries[city.country];
  }

  // A city's local prices are stored under its currency code (perRoomPerNightJPY in Japan,
  // perRoomPerNightCNY in China); `of` reads them, `format` prints them, `rate` turns them into KRW.
  function moneyFor(city) {
    const currency = currencies[countryOf(city).currency];
    const fx = findById(currency.fxOptions, state.fx[currency.code]) || currency.fxOptions[0];
    return {
      code: currency.code,
      currency,
      fx,
      rate: fx.krwPerUnit,
      of: (item, key) => (item ? item[key + currency.code] : undefined),
      format: (r, dash = "-") => {
        const [lo, hi] = r.map((value) => Math.round(value).toLocaleString("ko-KR"));
        return `${currency.prefix}${lo === hi ? lo : `${lo}${dash}${hi}`}${currency.suffix}`;
      },
    };
  }

  // Shared cards (rooms, meals, weeks) can carry another wording or number for one country under its id.
  function forCountry(item, country) {
    return item && item[country.id] ? { ...item, ...item[country.id] } : item;
  }

  function cheapestCityId(results) {
    let best = null;
    cityOrder.forEach((cityId) => {
      const mid = results[cityId].perPerson.mean;
      if (!best || mid < best.mid) best = { cityId, mid };
    });
    return best ? best.cityId : null;
  }

  function describeStayPrice(stay, money) {
    const perBed = money.of(stay, "perBedPerNight");
    const perRoom = money.of(stay, "perRoomPerNight");
    const perPerson = money.of(stay, "perPersonPerNight");
    const perUnit = money.of(stay, "perUnitPerNight");
    if (perBed) return `평일 1인 1침대 ${money.format(perBed)}/박`;
    if (perRoom && stay.roomCapacity) return `평일 ${stay.roomCapacity}인 1실 ${money.format(perRoom)}/박`;
    if (perPerson) return `평일 1인 ${money.format(perPerson)}/박`;
    if (perUnit) return `평일 ${stay.unitCapacity}인 1채 ${money.format(perUnit)}/박`;
    if (perRoom) return `평일 트윈 ${money.format(perRoom)}/박`;
    return "";
  }

  // Per-person ticket price; parks have a dearer tier on peak dates.
  function activityPrice(act, peak, money) {
    return (peak && money.of(act, "peakAdult")) || money.of(act, "adult") || [0, 0];
  }

  function describeActivityPrice(act, season, money) {
    if (money.of(act, "group")) return "무료";
    const peak = season.parkTier === "peak";
    const price = activityPrice(act, peak, money);
    const parts = [price[1] === 0 ? "무료" : `1인 ${money.format(price)}`];
    if (act.tag) parts.unshift(act.tag);
    if (act.note) parts.push(act.note);
    if (act.cash) parts.push("현금 위주");
    if (peak && money.of(act, "peakAdult")) parts.push("성수기 등급");
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

  // Topic particle after a name: "병원은", "택배는", "MIL(신사이바시)는". Looks at the last Hangul syllable.
  function withTopic(name) {
    const last = String(name).match(/[가-힣](?=[^가-힣]*$)/);
    const hasFinalConsonant = last ? (last[0].charCodeAt(0) - 0xac00) % 28 !== 0 : false;
    return `${name}${hasFinalConsonant ? "은" : "는"}`;
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

  function roundUp(value, step) {
    return Math.ceil(value / step) * step;
  }

  function sumRanges(...ranges) {
    return ranges.reduce((acc, r) => [acc[0] + r[0], acc[1] + r[1]], [0, 0]);
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

  // Signed difference for chips: "+3천원", "−1.5만원", "+12만원"; "" when it rounds to nothing.
  function formatDelta(value) {
    const abs = Math.abs(value);
    if (!Number.isFinite(value) || abs < 500) return "";
    const sign = value > 0 ? "+" : "−";
    if (abs < 9500) return `${sign}${Math.round(abs / 1000)}천원`;
    const man = abs / 10000;
    const shown = man < 9.95 ? Math.round(man * 10) / 10 : Math.round(man);
    return `${sign}${shown.toLocaleString("ko-KR")}만원`;
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
