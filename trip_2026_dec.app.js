(() => {
  const data = window.TRIP_DATA;
  if (!data) {
    console.error("TRIP_DATA not found. Load data.js first.");
    return;
  }

  const STORAGE_KEY = "trip_2026_dec_" + data.meta.appId + ".v3";
  const UI_KEY = "trip_2026_dec_" + data.meta.appId + ".ui.v1";
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
    parking: byId("parking-options"),
    parkingSection: byId("section-parking"),
    dataPlan: byId("data-options"),
    dataSection: byId("section-data"),
    stayPre: byId("stayPre-options"),
    roomConfig: byId("roomConfig-options"),
    stayA: byId("stayA-options"),
    stayB: byId("stayB-options"),
    stayBNights: byId("stayB-nights-controls"),
    titleStayB: byId("title-stayB"),
    meal: byId("meal-options"),
    transport: byId("transport-options"),
    activityControls: byId("activity-controls"),
    activityPacks: byId("activityPack-options"),
    titleStayA: byId("title-stayA"),
    titleRoomConfig: byId("title-roomConfig"),
    labelRxDay: byId("label-rxDay"),
    compareBlock: byId("compare-block"),
    pretripBlock: byId("pretrip-block"),
    pretripList: byId("pretrip-list"),
    pretripCount: byId("pretrip-count"),
    groupTotalLabel: byId("group-total-label"),
    groupTotalSub: byId("group-total-sub"),
    perMonthLabel: byId("per-month-label"),
    perMonthValue: byId("per-month-value"),
    perMonthSub: byId("per-month-sub"),
    titleStayPre: byId("title-stayPre"),
    titleClinic: byId("title-clinic"),
    titleActivities: byId("title-activities"),
    titleFlight: byId("title-flight"),
    titleAirport: byId("title-airport"),
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
    rxCondition: byId("rx-condition"),
    compareBody: byId("compare-body"),
    breakdown: byId("breakdown-list"),
    breakdownUnit: byId("breakdown-unit"),
    timeline: byId("timeline-list"),
    timelineWarning: byId("timeline-warning"),
    checkLinks: byId("check-links"),
    notes: byId("note-list"),
    openEvidence: byId("open-evidence"),
    closeEvidence: byId("close-evidence"),
    resetState: byId("reset-state"),
    evidenceModal: byId("evidence-modal"),
    evidenceAsOf: byId("evidence-asof"),
    headAsOf: byId("head-asof"),
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
    warnSlots: { rx: byId("warn-rx"), clinic: byId("warn-clinic"), data: byId("warn-data"), stayB: byId("warn-stayB"), activities: byId("warn-activities") },
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
    el.city, el.party, el.departure, el.duration, el.season, el.fx, el.rxPlan, el.rxDay, el.rxPatients, el.clinic, el.flight, el.airport, el.parking, el.dataPlan,
    el.stayPre, el.roomConfig, el.stayA, el.stayB, el.meal, el.transport, el.activityControls, el.activityPacks, el.compareBody,
  ];
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  // A page with one city has nothing to compare or switch between: the city cards, the note about
  // per-city choices and the comparison table are left out.
  const singleCity = cityOrder.length === 1;
  // Leading time-of-day word of a timeline line, shown as its own column.
  const DAY_SLOT = /^(아침|오전|점심|오후|저녁|밤) /;

  const state = loadState() || createInitialState();
  state.ui = loadUi();
  let pressed = null; // the button a click landed on, noted before the handlers re-render it
  let lastMean = null;
  let deltaTimer = null;
  let toastTimer = null;
  let toastUndo = null;
  let cardsMark = null; // where the reader was in the cards before jumping to the result on a phone

  // One column (phone, narrow window): the result sits above the cards, so the long to-do list starts folded.
  if (window.matchMedia("(max-width: 980px)").matches) el.pretripBlock.open = false;

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
      durationId: pickId(data.durations, (data.initial || {}).durationId || "n3"),
      seasonId: pickId(data.seasons, (data.initial || {}).seasonId || "w1211"),
      fx: pickFx({}),
      rxPlan: pickRxPlans({}),
      rxDayId: pickId(rx.days, (data.initial || {}).rxDayId || "rx_d2"),
      rxPatients: rx.patients.matchTravelers ? data.party.travelers.defaultValue : rx.patients.defaultValue,
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
      parkingId: pickId(parkingOptionsFor(city, flight), d.parkingId),
      dataId: pickId(city.dataPlans, d.dataId),
      clinicId: pickId(city.clinics, d.clinicId),
      stayPreId: pickId(city.staysPre, d.stayPreId),
      roomConfigId: pickId(data.roomConfigs, d.roomConfigId),
      stayAId: pickId(city.staysA, d.stayAId),
      stayBId: pickId(city.staysB, d.stayBId),
      stayBNights: Number(d.stayBNights || 1),
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

  function legacyFx(fxId) {
    const saved = {};
    if (!fxId) return saved;
    Object.values(currencies).forEach((currency) => {
      if (findById(currency.fxOptions, fxId)) saved[currency.code] = fxId;
    });
    return saved;
  }

  function legacyRxPlan(planId) {
    const saved = {};
    if (!planId) return saved;
    Object.values(countries).forEach((country) => {
      if (findById(country.rxPlans, planId)) saved[country.id] = planId;
    });
    return saved;
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
        // An earlier single-country page saved one rate in fxId and one plan in rxPlanId, without
        // saying which currency or country they belong to. Adopt them where the id actually exists.
        fx: pickFx(saved.fx || legacyFx(saved.fxId)),
        rxPlan: pickRxPlans(saved.rxPlan || legacyRxPlan(saved.rxPlanId)),
        rxDayId: pickId(rx.days, saved.rxDayId || base.rxDayId),
        cities: {},
      };
      next.rxPatients = rx.patients.matchTravelers
        ? next.travelers
        : clamp(saved.rxPatients ?? base.rxPatients, rx.patients.min, next.travelers);

      // A city only reachable at one time of day (Tsushima: morning ferry from Busan) carries its own
      // preferred departure; keep it in force on load as well as on a city click.
      if (cities[next.cityId] && cities[next.cityId].departureId
          && findById(data.departures, cities[next.cityId].departureId)) {
        next.departureId = cities[next.cityId].departureId;
      }

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
          parkingId: pickId(parkingOptionsFor(city, flight), savedCity.parkingId || fallback.parkingId),
          dataId: pickId(city.dataPlans, savedCity.dataId || fallback.dataId),
          clinicId: pickId(city.clinics, savedCity.clinicId || fallback.clinicId),
          stayPreId: pickId(city.staysPre, savedCity.stayPreId || fallback.stayPreId),
          roomConfigId: pickId(data.roomConfigs, savedCity.roomConfigId || fallback.roomConfigId),
          stayAId: pickId(city.staysA, savedCity.stayAId || fallback.stayAId),
          stayBId: pickId(city.staysB, savedCity.stayBId || fallback.stayBId),
          stayBNights: clamp(savedCity.stayBNights ?? fallback.stayBNights ?? 1, 1, 3),
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
    // done: pre-trip to-dos ticked off, keyed by their text.
    const ui = { accordion: createInitialAccordionState(), tab: TABS[0], done: {} };
    try {
      const saved = JSON.parse(window.localStorage.getItem(UI_KEY) || "null");
      if (saved && typeof saved === "object") {
        if (saved.done && typeof saved.done === "object") {
          Object.keys(saved.done).forEach((key) => {
            if (saved.done[key] === true) ui.done[key] = true;
          });
        }
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
      mobile ? ["city", "schedule", "rx", "clinic"] : ["city", "party", "schedule", "rx", "clinic", "flight", "parking", "data", "stayPre", "stayA", "activities"]
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
      if (cities[id]) {
        state.cityId = id;
        // Some cities are only reachable at a certain time (Tsushima: morning ferry from Busan),
        // so they carry a preferred departure that is applied when the city is picked.
        if (cities[id].departureId && findById(data.departures, cities[id].departureId)) {
          state.departureId = cities[id].departureId;
        }
      }
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
      const parking = parkingOptionsFor(city, findById(city.flights, id));
      if (!findById(parking, s.parkingId)) s.parkingId = parking.length ? parking[0].id : null;
    });
    onCardClick(el.airport, (id) => {
      cityState().airportId = id;
    });
    onCardClick(el.parking, (id) => {
      cityState().parkingId = id;
    });
    onCardClick(el.dataPlan, (id) => {
      cityState().dataId = id;
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
    if (el.stayBNights) {
      el.stayBNights.addEventListener("click", (event) => {
        const btn = event.target.closest("button[data-stayb-nights]");
        if (!btn) return;
        cityState().stayBNights = clamp(Number(btn.dataset.staybNights), 1, 3);
        commit();
      });
    }
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
      state.rxPatients = rx.patients.matchTravelers
        ? state.travelers
        : clamp(state.rxPatients, rx.patients.min, state.travelers);
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
    // Links inside a tab that lead to another tab ("확정가 넣으러 가기").
    el.resultScroll.addEventListener("click", (event) => {
      const btn = event.target.closest("button[data-goto-tab]");
      if (!btn) return;
      selectTab(btn.dataset.gotoTab);
      byId(`tab-${btn.dataset.gotoTab}`).focus({ preventScroll: true });
    });

    // Ticking a to-do is kept per browser; the row is updated in place, so nothing else re-renders.
    el.pretripList.addEventListener("change", (event) => {
      const box = event.target.closest("input[data-done]");
      if (!box) return;
      if (box.checked) state.ui.done[box.dataset.done] = true;
      else delete state.ui.done[box.dataset.done];
      saveUi();
      box.closest("li").classList.toggle("is-done", box.checked);
      renderPretripCount();
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
    el.mobileBarJump.textContent = viewingResult() ? "카드 고르기 ↓" : "결과 보기 ↑";
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
    renderCards(el.season, data.seasons, state.seasonId, null, ifShared("seasonId"));
    renderCards(el.fx, money.currency.fxOptions, money.fx.id, null, (item) => meanIf({ fx: { ...state.fx, [money.code]: item.id } }) - base);
    renderCards(
      el.rxPlan,
      country.rxPlans.map((plan) => ({ ...plan, title: planTitle(plan, country) })),
      state.rxPlan[country.id],
      (item) => {
        const month = perRxMonth(computeIf({ rxPlan: { ...state.rxPlan, [country.id]: item.id } }));
        return { sub: item.subtitle, meta: month ? `1개월분당 약 ${formatManwon(month.mean)}` : "" };
      },
      (item) => meanIf({ rxPlan: { ...state.rxPlan, [country.id]: item.id } }) - base
    );
    renderCards(
      el.rxDay,
      rx.days.map((day) => ({ ...day, title: `${day.title} · ${formatDate(addDays(result.startDate, day.dayIndex))}` })),
      state.rxDayId,
      null,
      ifShared("rxDayId")
    );
    renderRxPatients(country);
    // Price what each clinic actually hands out, and the per-month figure, since a clinic
    // that gives 4 weeks makes the trip cheaper in total but far dearer per month.
    const describeClinic = (item) => {
      const plan = capPlanToClinic(rxPlanFor(country), item);
      const month = perRxMonth(computeIf(null, { clinicId: item.id }));
      const capped = plan.cappedFrom ? ` (${planTitle(plan, country)}만)` : "";
      const perMonth = month ? ` · 1개월분당 약 ${formatManwon(month.mean)}` : "";
      return { sub: item.subtitle, meta: `1인 약값 ${money.format(rxDrugCost(item, plan, money))}${capped}${perMonth}` };
    };
    // A city can sort its clinics under headings (e.g. delivery to the hotel / visit in person).
    const clinicGroups = (city.clinicGroups || [])
      .map((group) => ({ label: group.label, items: city.clinics.filter((clinic) => group.modes.includes(clinic.mode)) }))
      .filter((group) => group.items.length);
    if (clinicGroups.length && sum(clinicGroups.map((group) => group.items.length)) === city.clinics.length) {
      renderCardGroups(el.clinic, clinicGroups, s.clinicId, describeClinic, ifCity("clinicId"));
    } else {
      renderCards(el.clinic, city.clinics, s.clinicId, describeClinic, ifCity("clinicId"));
    }
    renderCards(
      el.flight,
      city.flights,
      s.flightId,
      (item) => ({ sub: item.subtitle, meta: `1인 왕복 ${formatKRWRange(item.priceKRW)}` }),
      ifCity("flightId")
    );
    renderCards(el.airport, airportOptionsFor(city, flight), s.airportId, null, ifCity("airportId"));
    const parkingOptions = parkingOptionsFor(city, flight);
    if (el.parkingSection) el.parkingSection.hidden = !parkingOptions.length;
    if (parkingOptions.length) {
      renderCards(
        el.parking,
        parkingOptions,
        s.parkingId,
        (item) => ({
          sub: item.subtitle,
          meta: `${parkingNoteFor(item, result.nights, result.people)} · ${formatWonRange(parkingCost(item, result.nights, result.people))}`,
        }),
        ifCity("parkingId")
      );
    }
    // Mobile data for the trip (roaming eSIM, home-carrier roaming, local SIM), for cities that list plans.
    const dataPlans = city.dataPlans || [];
    if (el.dataSection) el.dataSection.hidden = !dataPlans.length;
    if (dataPlans.length) {
      renderCards(
        el.dataPlan,
        dataPlans,
        s.dataId,
        (item) => ({ sub: item.subtitle, meta: `1인 ${formatWonRange(item.perPersonKRW)}` }),
        ifCity("dataId")
      );
    }
    const describeStay = (item) => ({ sub: item.subtitle, meta: describeStayPrice(item, money) });
    renderCards(el.stayPre, city.staysPre, s.stayPreId, describeStay, ifCity("stayPreId"));
    // A room for more people than are travelling is not an option (the picked one always stays listed).
    renderCards(
      el.roomConfig,
      data.roomConfigs.filter((item) => item.occupancy <= state.travelers || item.id === s.roomConfigId),
      s.roomConfigId,
      (item) => ({ sub: item.subtitle, meta: `${state.travelers}명 → ${roomCountFor(item, state.travelers)}실` }),
      ifCity("roomConfigId")
    );
    renderCards(el.stayA, city.staysA, s.stayAId, describeStay, ifCity("stayAId"));
    renderCards(el.stayB, city.staysB, s.stayBId, describeStay, ifCity("stayBId"));
    renderStayBNights(result);
    renderCards(
      el.meal,
      data.mealLevels,
      s.mealId,
      (item) => ({ sub: item.subtitle, meta: `1인 ${money.format(money.of(item, "perPersonPerDay"))}/일` }),
      ifCity("mealId")
    );
    renderCards(el.transport, city.transports, s.transportId, null, ifCity("transportId"));
    renderActivityControls(city, s, money);
    // Packs are shortcuts, not a standing choice, so a lone pack is still a button.
    renderCards(
      el.activityPacks,
      city.packs,
      s.packId,
      null,
      (pack) => meanIf(null, { activities: packActivities(city, s.activities, pack) }) - base,
      { fixedWhenSingle: false }
    );

    // The whole trip in one hotel (the pre-stay card says "same hotel"): nothing moves on the prescription day.
    const sameHotel = !result.lodgingPre && Boolean(result.stayPre.sameAsStayA);
    if (el.titleStayPre) {
      el.titleStayPre.textContent = result.stayPre.sameAsStayA
        ? `처방 전 숙소 · 처방 후 숙소에 그대로 (${result.preNights}박)`
        : `처방 전 숙소 · 초저가 (${result.preNights}박)`;
    }
    if (el.titleStayA) {
      el.titleStayA.textContent = sameHotel
        ? `A숙소 · 시내 메인 (${result.nightsA}박)`
        : `처방 후 숙소 · 2인 1실 (${result.nightsA}박)`;
    }
    if (el.titleStayB) {
      el.titleStayB.textContent = result.stayB
        ? `B숙소 · 시내 가성비 (${result.nightsB}박)`
        : "B숙소 (시내 가성비 분할 1·2박, 선택)";
    }
    if (el.titleRoomConfig) el.titleRoomConfig.textContent = sameHotel ? "객실 구성" : "처방 후 객실 구성";
    if (el.labelRxDay) el.labelRxDay.textContent = sameHotel ? "처방일 · 약을 받는 날" : "처방일 (이날 밤부터 2인 1실)";
    if (el.titleClinic) el.titleClinic.textContent = singleCity ? "처방 클리닉 · 수령 방식" : `처방 클리닉 · 수령 방식 · ${city.name}`;
    if (el.titleActivities) el.titleActivities.textContent = singleCity ? "관광 · 이색 식사" : `관광 · 이색 식사 · ${city.name}`;
    if (el.titleFlight) el.titleFlight.textContent = city.flightTitle || "항공 (1인 왕복)";
    if (el.titleAirport) el.titleAirport.textContent = city.airportTitle || "공항 이동";
    if (el.titleFx) el.titleFx.textContent = `환율 · ${money.currency.name}`;
    if (el.labelRxPlan) {
      el.labelRxPlan.innerHTML = `용량 · 수량${singleCity ? "" : ` · ${esc(country.name)} 도시 공통`} <small>${esc(country.penNote)}</small>`;
    }
    // With one city there is no city to pick and nothing saved per city; a pre-stay section whose
    // only card is "same hotel" has nothing to choose either.
    setSectionHidden("city", singleCity);
    setSectionHidden("stayPre", city.staysPre.length === 1 && Boolean(city.staysPre[0].sameAsStayA));
    el.cityDivider.hidden = singleCity;
    if (el.compareBlock) el.compareBlock.hidden = singleCity;
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
    window.dispatchEvent(new CustomEvent("trip:rendered", { detail: { state, result, results } }));
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
  // A conflict is repeated in every section that can fix it; a reminder appears once, in its first section.
  function renderWarnings(warnings, conflicts) {
    Object.entries(el.warnSlots).forEach(([scope, node]) => {
      const mine = warnings.filter((warning) => (warning.conflict ? warning.scopes.includes(scope) : warning.scopes[0] === scope));
      node.hidden = !mine.length;
      node.innerHTML = warningsHtml(mine);
      const categoryEl = node.closest(".category");
      if (categoryEl) categoryEl.classList.toggle("has-warning", mine.some((warning) => warning.conflict));
    });
    el.tabPlanBadge.hidden = !conflicts;
    el.tabPlanBadge.textContent = conflicts ? `주의 ${conflicts}` : "";
  }

  // Conflicts (the plan does not work as picked) first and in the stronger tone; reminders after.
  function warningsHtml(warnings) {
    return [...warnings]
      .sort((a, b) => Number(Boolean(b.conflict)) - Number(Boolean(a.conflict)))
      .map(
        (warning) =>
          `<p class="warn ${warning.conflict ? "is-conflict" : "is-info"}"><strong class="warn-tag">${warning.conflict ? "주의" : "확인"}</strong>${esc(warning.text)}</p>`
      )
      .join("");
  }

  function setSectionHidden(section, hidden) {
    const node = el.categories.find((categoryEl) => categoryEl.dataset.section === section);
    if (node) node.hidden = hidden;
  }

  function renderStayBNights(result) {
    if (!el.stayBNights) return;
    const postNights = result.nights - result.lodgingPre;
    if (!result.stayB || postNights < 2) {
      el.stayBNights.innerHTML = "";
      return;
    }
    const maxB = Math.min(2, postNights - 1);
    const buttons = [];
    for (let b = 1; b <= maxB; b += 1) {
      const a = postNights - b;
      const active = b === result.nightsB;
      buttons.push(
        `<button type="button" class="qty-btn ${active ? "active" : ""}" data-stayb-nights="${b}" aria-pressed="${active}">A ${a}박 + B ${b}박</button>`
      );
    }
    el.stayBNights.innerHTML = `
      <div class="activity-row" style="margin-top:10px">
        <span class="activity-label">A / B 숙소 박수 배분<small>총 ${postNights}박 중 A숙소(${result.nightsA}박) · B숙소(${result.nightsB}박)</small></span>
        <div class="qty-group" role="group" aria-label="A숙소 B숙소 박수 배분">${buttons.join("")}</div>
      </div>
    `;
  }

  function renderRxPatients(country) {
    if (rx.patients.matchTravelers) {
      el.rxPatients.innerHTML = `
        <div class="activity-row">
          <span class="activity-label">처방받는 인원<small>여행 인원(${state.travelers}명)과 자동 연동 · 1인 최대 ${importLimitPens(country)}펜(${esc(country.importLimitNote)})까지 국내 반입</small></span>
          <span class="sh-pill is-soft" style="flex:none">여행 인원 ${state.travelers}명 적용</span>
        </div>
      `;
      return;
    }
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
    const items = [`<strong class="note-lead">${esc(booking.when)}</strong>${esc(booking.text)}`];
    (clinic.prep || []).forEach((line) => items.push(noteHtml(line)));
    if (clinic.link) {
      items.push(`<a href="${esc(clinic.link.href)}" target="_blank" rel="noopener noreferrer">${esc(clinic.link.label)} ↗</a>`);
    }
    items.push(noteHtml(`결제: ${clinic.payment}`));
    items.push(noteHtml("여권: 진료·수령 모두 본인 확인에 필요"));
    const c = result.customs;
    if (c && c.dutyFreeLimitKRW) {
      if (c.isOverLimit) {
        items.push(noteHtml(`관세·면세 주의: 1인 약값 약 ${formatManwon(c.perPatientDrugKRW)}로 면세 한도($${c.dutyFreeLimitUSD} · 약 ${formatManwon(c.dutyFreeLimitKRW)}) 초과 → 초과분 자진신고 시 예상 세액 1인 약 ${formatManwon(c.estTaxSelfKRW)} (30% 감면, 미신고 적발 시 가산세 40%)`));
      } else {
        items.push(noteHtml(`관세·면세 안전: 1인 약값 약 ${formatManwon(c.perPatientDrugKRW)} (면세 한도 $${c.dutyFreeLimitUSD} · 약 ${formatManwon(c.dutyFreeLimitKRW)} 이내, 잔여 쇼핑 면세 여력 약 ${formatManwon(c.remainingDutyFreeKRW)})`));
      }
    }
    items.push(noteHtml(`귀국: 1인 ${importLimitPens(country)}펜 이하(3개월분 안전) · 여행자 면세 한도 $800(약 112만원, 다른 쇼핑 합산) 초과 시 자진신고 · 영수증·처방 내역·원래 상자 · 펜은 기내 휴대. 출국 전 관세청(125)에 최신 기준 확인`));
    el.rxPrep.innerHTML = items.map((item) => `<li>${item}</li>`).join("");
    renderCash(result);
  }

  function renderCash(result) {
    const c = result.cash;
    const country = result.country;
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
      [taxLabel(country), c.tax, "프런트 현장 결제가 많음"],
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
        <span>여행 인원</span>
        <div class="qty-group" role="group" aria-label="여행 인원">${buttons.join("")}</div>
      </div>
      <p class="field-note">${esc(data.party.note)}</p>
    `;
  }

  // describe(item) gives the card's text under the title: { sub, meta }, where sub is the description
  // and meta the computed figures (price, per-month cost) on a line of their own. Without it the
  // card shows item.subtitle. A list with a single item is not a choice, so it is shown as plain
  // information instead of a button (opts.fixedWhenSingle: false keeps it a button).
  function renderCards(container, list, selectedId, describe, deltaFn, opts = {}) {
    const items = Array.isArray(list) ? list : [];
    const fixed = items.length === 1 && opts.fixedWhenSingle !== false;
    const group = container.closest(".card-group");
    if (group) group.classList.toggle("is-fixed", fixed);
    container.classList.remove("is-grouped");
    if (!items.length) {
      container.innerHTML = `<p class="empty-hint">선택 항목 없음</p>`;
      return;
    }
    container.innerHTML = items.map((item) => cardHtml(item, item.id === selectedId, describe, deltaFn, fixed)).join("");
  }

  // The same cards under headings: groups = [{ label, items }].
  function renderCardGroups(container, groups, selectedId, describe, deltaFn) {
    container.classList.add("is-grouped");
    container.innerHTML = groups
      .map(
        (group) => `
          <div class="card-group">
            <p class="group-label">${esc(group.label)}</p>
            <div class="card-grid card-grid-wide">
              ${group.items.map((item) => cardHtml(item, item.id === selectedId, describe, deltaFn, false)).join("")}
            </div>
          </div>
        `
      )
      .join("");
  }

  function cardHtml(item, active, describe, deltaFn, fixed) {
    const described = describe ? describe(item) : null;
    const subText = described ? described.sub : item.subtitle;
    const sub = subText ? `<span class="sub">${esc(subText)}</span>` : "";
    const meta = described && described.meta ? `<span class="meta">${esc(described.meta)}</span>` : "";
    if (fixed) {
      return `
        <div class="card-btn is-fixed">
          <span class="title">${esc(item.title)}</span>
          ${sub}
          ${meta}
        </div>
      `;
    }
    const deltaValue = !active && deltaFn ? deltaFn(item) : 0;
    const deltaText = formatDelta(deltaValue);
    const delta = deltaText ? `<span class="delta ${deltaValue > 0 ? "is-up" : "is-down"}">${esc(deltaText)}</span>` : "";
    const grade = item.verification && item.verification.grade;
    const gradeBadge = grade
      ? `<span class="grade-pill is-grade-${esc(grade)}">${grade === "excluded" ? "제외" : `${esc(grade)}등급`}</span>`
      : "";
    return `
      <button type="button" class="card-btn ${active ? "active" : ""}" data-id="${esc(item.id)}" aria-pressed="${active}">
        <span class="title">${esc(item.title)} ${gradeBadge}</span>
        ${sub}
        ${meta}
        ${delta}
      </button>
    `;
  }

  function renderActivityControls(city, s, money) {
    const season = currentSeason();
    const row = (act) => {
      const price = describeActivityPrice(act, season, money);
      const tag = act.tag ? `<span class="act-tag">${esc(act.tag)}</span>` : "";
      const note = price.note ? ` · ${esc(price.note)}` : "";
      const label = `<span class="activity-label"><span class="act-title">${esc(act.title)}${tag}</span><small><b>${esc(price.price)}</b>${note}</small></span>`;
      const toggle = (on, attrs, extra = "") =>
        `<button type="button" class="toggle-btn ${on ? "active" : ""}" ${attrs} aria-pressed="${on}">${on ? "✓ 포함" : "추가"}${extra}</button>`;

      if (act.kind === "toggle") {
        const on = Boolean(s.activities[act.id]);
        const disabledNote = act.perUnitOf && !Number(s.activities[act.perUnitOf] || 0) ? " (USJ 0일)" : "";
        return `<div class="activity-row is-compact">${label}${toggle(on, `data-activity-toggle="${esc(act.id)}"`, disabledNote)}</div>`;
      }

      const selected = Number(s.activities[act.id] || 0);
      const min = act.min ?? 0;
      const max = act.max ?? 0;
      // "0 or 1 time" is a yes/no like the toggles above, so it gets the same button.
      if (min === 0 && max === 1) {
        return `<div class="activity-row is-compact">${label}${toggle(selected > 0, `data-activity="${esc(act.id)}" data-qty="${selected > 0 ? 0 : 1}"`)}</div>`;
      }
      const buttons = [];
      for (let qty = min; qty <= max; qty += 1) {
        const active = qty === selected;
        buttons.push(
          `<button type="button" class="qty-btn ${active ? "active" : ""}" data-activity="${esc(act.id)}" data-qty="${qty}" aria-pressed="${active}" aria-label="${qty}회">${qty}</button>`
        );
      }
      return `
        <div class="activity-row ${max - min <= 2 ? "is-compact" : ""}">
          ${label}
          <div class="qty-group" role="group" aria-label="${esc(act.title)} 횟수">${buttons.join("")}</div>
        </div>
      `;
    };

    // A city can sort its long list under headings by the part of the day each item takes.
    const groups = (city.activityGroups || [])
      .map((group) => ({ label: group.label, items: city.activities.filter((act) => group.slots.includes(act.slot)) }))
      .filter((group) => group.items.length);
    const grouped = groups.length && sum(groups.map((group) => group.items.length)) === city.activities.length;
    el.activityControls.innerHTML = grouped
      ? groups
          .map((group) => {
            const picked = group.items.filter((act) => (act.kind === "toggle" ? s.activities[act.id] : Number(s.activities[act.id] || 0) > 0)).length;
            return `
              <div class="activity-group">
                <p class="group-label">${esc(group.label)} <small>${picked}/${group.items.length} 선택</small></p>
                ${group.items.map(row).join("")}
              </div>
            `;
          })
          .join("")
      : city.activities.map(row).join("");
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
    const capNote = result.rxPlan.cappedFrom ? " (병원 한도)" : "";
    set("summary-rx", `${planTitle(result.rxPlan, result.country)}${capNote} · ${result.rxPatients}명 · Day${result.preNights + 1}`);
    set("summary-clinic", result.clinic.short);
    set("summary-stayPre", result.preNights ? titleOf(city.staysPre, s.stayPreId) : "없음 (도착일 처방)");
    set("summary-flight", titleOf(city.flights, s.flightId));
    set("summary-airport", titleOf(airportOptionsFor(city, findById(city.flights, s.flightId)), s.airportId));
    set("summary-parking", result.parking ? `${result.parking.short || result.parking.title} · ${formatManwon(result.breakdown.parking.mean)}` : "");
    set("summary-data", result.dataPlan ? result.dataPlan.short || result.dataPlan.title : "");
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
    el.perPersonTotal.textContent = `약 ${formatManwon(pp.mean)}`;
    el.perPersonBand.textContent = `80% 확률로 ${formatBand(pp.band)}`;
    el.groupTotalLabel.textContent = result.people > 1 ? `${result.people}명 총액` : "총액";
    el.groupTotal.textContent = `약 ${formatManwon(result.total.mean)}`;
    el.groupTotalSub.textContent = `${formatBand(result.total.band)} · ${result.money.fx.title}`;
    const month = perRxMonth(result);
    el.perMonth.hidden = !month;
    if (month) {
      el.perMonthValue.textContent = `약 ${formatManwon(month.mean)}`;
      el.perMonthLabel.textContent = `여행비 포함 1개월당 (총액 ÷ ${formatMonths(month.months)})`;
      el.perMonthSub.textContent = `${formatBand(month.band)} · 순수 약값·진료비 ${formatManwon(month.drug)}/개월`;
    }
    // A route open only to some patients (e.g. online sale limited to diabetes) says so next to the price.
    if (el.rxCondition) {
      el.rxCondition.hidden = !result.clinic.eligibility;
      el.rxCondition.innerHTML = result.clinic.eligibility
        ? `<strong class="warn-tag">조건</strong>${esc(result.clinic.short)}: ${esc(result.clinic.eligibility)}`
        : "";
    }
    if (el.breakdownUnit) el.breakdownUnit.textContent = result.people > 1 ? `${result.people}명 합계` : "";

    const b = result.breakdown;
    const savingsText = result.rxSavings > 0 ? ` · 국내 처방보다 약 ${formatManwon(result.rxSavings)} 저렴` : "";
    const rows = [
      ["마운자로 처방", b.rx, `${result.clinic.short} · ${planTitle(result.rxPlan, result.country)}${result.rxPlan.cappedFrom ? "(병원 한도)" : ""} × ${result.rxPatients}명${savingsText}`],
      [city.flightRow || "항공", b.flight, result.flightNote],
      ["국내 공항 주차", b.parking, result.parking ? `${result.parking.title} · ${result.parkingNote}` : ""],
      ["숙박", b.stay, result.stayNote],
      [taxLabel(result.country), b.stayTax, "1인 1박 기준, 현장 결제"],
      ["식비", b.meal, `${result.mealDays}일 기준`],
      [city.airportRow || "공항 이동", b.airport, titleOf(airportOptionsFor(city, findById(city.flights, cityState().flightId)), cityState().airportId)],
      ["시내 교통", b.transport, titleOf(city.transports, cityState().transportId)],
      ["인터넷", b.data, result.dataPlan ? result.dataPlan.short || result.dataPlan.title : ""],
      ["근교 이동", b.excursion, result.stayB ? `${result.stayB.short || result.stayB.title} 왕복` : ""],
      ["액티비티", b.activities, result.activityCount ? `관광·이색 식사 ${result.activityCount}가지` : ""],
      ["예비비", b.contingency, `예상 합계의 ${pct(calculationRules.contingencyRate)} · 범위에 영향 없음`],
    ].filter(([label, line]) => {
      if (label === "국내 공항 주차") return Boolean(result.parking);
      if (label === "인터넷") return Boolean(result.dataPlan);
      return (label !== "근교 이동" && label !== taxLabel(result.country)) || line.hi > 0;
    });

    // The bar under each row is its share of the largest row, so the big items stand out at a glance.
    const largest = Math.max(1, ...rows.map(([, line]) => line.mean));
    el.breakdown.innerHTML =
      rows
        .map(([label, line, note]) => {
          const detail = lineDetail(line);
          const share = Math.max(0, Math.min(100, (line.mean / largest) * 100));
          return `
            <li>
              <span>${esc(label)}${note ? `<small>${esc(note)}</small>` : ""}</span>
              <strong>${formatManwon(line.mean)}${detail ? `<small class="${line.locked ? "is-locked" : ""}">${esc(detail)}</small>` : ""}</strong>
              <span class="share-bar" aria-hidden="true"><span style="width:${share.toFixed(1)}%"></span></span>
            </li>
          `;
        })
        .join("") +
      `<li class="is-total">
        <span>합계${result.people > 1 ? `<small>1인 약 ${formatManwon(result.perPerson.mean)}</small>` : ""}</span>
        <strong>${formatManwon(result.total.mean)}<small>${esc(formatBand(result.total.band))}</small></strong>
      </li>`;
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
          `${r.lodgingPre ? `${r.stayPre.short} → ` : ""}${shortTitle(titleOf(city.staysA, s.stayAId))}`,
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
    // A line that starts with a time of day ("저녁 와이탄 야경") shows that word in its own column.
    const itemHtml = (item) => {
      const slot = item.match(DAY_SLOT);
      const text = slot ? item.slice(slot[0].length) : item;
      return `<li><span class="day-slot">${slot ? esc(slot[1]) : ""}</span><span>${esc(text)}</span></li>`;
    };
    el.timeline.innerHTML = plan.days
      .map(
        (day, index) => `
          <li class="day ${day.rx ? "is-rx" : ""}">
            <div class="day-head">
              <strong class="day-num">Day${index + 1}</strong>
              <span class="day-date">${esc(formatDate(day.date))}</span>
              ${day.rx ? `<span class="day-tag">처방일</span>` : ""}
              ${day.night ? `<span class="day-night">${esc(day.night)} 숙박</span>` : `<span class="day-night">귀국</span>`}
            </div>
            <ul class="day-items">${day.items.map(itemHtml).join("")}</ul>
          </li>
        `
      )
      .join("");

    // Pre-trip to-dos in date order, each with a checkbox remembered per browser.
    el.pretripBlock.hidden = !plan.preTrip.length;
    el.pretripList.innerHTML = plan.preTrip
      .map((step) => {
        const done = Boolean(state.ui.done[step.text]);
        return `
          <li class="${done ? "is-done" : ""}">
            <label>
              <input type="checkbox" data-done="${esc(step.text)}" ${done ? "checked" : ""} />
              <span class="check-when">${esc(step.when)}</span>
              <span class="check-text">${esc(step.text)}</span>
            </label>
          </li>
        `;
      })
      .join("");
    renderPretripCount();

    el.timelineWarning.hidden = !warnings.length;
    el.timelineWarning.innerHTML = warningsHtml(warnings);
  }

  function renderPretripCount() {
    const boxes = Array.from(el.pretripList.querySelectorAll("input[data-done]"));
    const done = boxes.filter((box) => box.checked).length;
    el.pretripCount.textContent = boxes.length ? `${done}/${boxes.length} 완료` : "";
    el.pretripCount.classList.toggle("is-complete", boxes.length > 0 && done === boxes.length);
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
      if (money.of(stay, "perBedPerNight")) return "도미토리·캡슐";
      if (money.of(stay, "perUnitPerNight")) return "2룸(침실 2개)";
      if (money.of(stay, "perPersonPerNight")) return `${roomConfig.occupancy}인 1실`;
      return roomConfig.occupancy === 2 ? "트윈(침대 2개)" : roomConfig.title;
    };
    const unitWord = (stay) => (money.of(stay, "perBedPerNight") ? "침대" : money.of(stay, "perUnitPerNight") ? "채" : "실");
    const departureTime = { night: "저녁 출발", afternoon: "낮 출발" }[currentDeparture().arrival] || "오전 출발";
    const origin = flight.from || "ICN";
    const flightQuery = `Flights from ${origin} to ${flight.airport} on ${start} through ${end}`;
    const flightSlot = flight.link
      ? {
          label: flight.link.label || `${flight.title} ${formatDate(start)}–${formatDate(end)}`,
          sub: flight.link.sub || `${flight.title} · ${departureTime} 편으로 고르기`,
          href: flight.link.href,
        }
      : {
          label: `항공권 · ${origin}→${flight.airport} ${formatDate(start)}–${formatDate(end)}`,
          sub: `Google Flights · ${flight.title} · 첫날 ${departureTime} 편으로 고르기`,
          href: `https://www.google.com/travel/flights?hl=ko&curr=KRW&q=${encodeURIComponent(flightQuery)}`,
        };

    const slots = {
      flight: flightSlot,
      stayPre: result.lodgingPre
        ? {
            label: `처방 전 · ${stayPre.title} ${formatDate(start)}–${formatDate(checkoutPre)}`,
            sub: `Booking.com · ${money.of(stayPre, "perBedPerNight") ? `${result.people}침대 (남녀 구역 확인)` : `개인실 ${result.roomsPre}실`}`,
            href: bookingUrl(stayPre.booking || city.bookingCity, start, checkoutPre, result.roomsPre),
          }
        : null,
      stayA: {
        label: `${result.lodgingPre ? "처방 후" : "숙소"} · ${stayA.title} ${formatDate(checkoutPre)}–${formatDate(checkoutA)}`,
        sub: `Booking.com · ${roomType(stayA)} ${result.roomsA}${unitWord(stayA)} · 객실 냉장고 확인`,
        href: bookingUrl(stayA.booking || city.bookingCity, checkoutPre, checkoutA, result.roomsA, stayA.bookingFilter),
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
    const cityNotes = [...(currentSeason().notes || []), ...(city.notes || [])];
    Object.entries(city.dateNotes || {}).forEach(([iso, text]) => {
      if (iso >= result.startDate && iso <= addDays(result.startDate, result.nights)) cityNotes.push(text);
    });
    // Everything pushed below is about rooms and flights.
    const notes = [];
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
    // Grouped so the long list reads by topic: carrying the drug home, the country, the city, the bookings.
    const groups = [
      ["반입 · 보관 · 복용", rx.notes || []],
      [`${country.name} 처방 · 결제`, country.rxNotes || []],
      ...(city.noteGroups || []).map((group) => [group.title, group.notes || []]),
      [city.name, cityNotes],
      ["숙박 · 항공", notes],
    ].filter(([, list]) => list.length);
    // Each topic folds; which ones are open is kept in the DOM across renders by updating in place.
    const open = new Set(Array.from(el.notes.querySelectorAll("details[open]")).map((node) => node.dataset.group));
    const first = !el.notes.children.length;
    el.notes.innerHTML = groups
      .map(
        ([title, list], index) =>
          `<details class="fold note-group" data-group="${esc(title)}" ${(first ? index === 0 : open.has(title)) ? "open" : ""}>
            <summary><span class="note-group-title">${esc(title)}</span><span class="fold-count">${list.length}</span></summary>
            <ul class="note-list">${list.map((note) => `<li>${noteHtml(note)}</li>`).join("")}</ul>
          </details>`
      )
      .join("");
  }

  // "택배 수령: 받는 사람은…" → the short topic before the colon is set in bold so the list can be scanned.
  function noteHtml(note) {
    const lead = String(note).match(/^([^:.]{2,16}): /);
    if (!lead) return esc(note);
    return `<strong class="note-lead">${esc(lead[1])}</strong>${esc(String(note).slice(lead[0].length))}`;
  }

  function renderEvidence() {
    el.evidenceAsOf.textContent = data.meta.asOf;
    if (el.headAsOf) el.headAsOf.textContent = data.meta.asOf;
    const sharedTitle = data.meta.sharedGroupTitle || "공통 (마운자로 반입·가격·보관, 계산 방식·환율·숙박세·시기·객실·식비)";
    const groups = [{ title: sharedTitle, items: collectShared() }];
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
    [city.clinics, city.flights, city.airportTransfers, city.homeParking, city.dataPlans, city.staysPre, city.staysA, city.staysB, city.transports, city.activities].forEach((list) => {
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
    const season = currentSeason();
    const departure = currentDeparture();
    const fx = money.rate;
    const peak = season.parkTier === "peak";

    const flight = findById(city.flights, s.flightId);
    const airport = findById(airportOptionsFor(city, flight), s.airportId) || airportOptionsFor(city, flight)[0];
    const roomConfig = findById(data.roomConfigs, s.roomConfigId);
    const stayPre = findById(city.staysPre, s.stayPreId) || city.staysPre[0];
    const stayA = findById(city.staysA, s.stayAId);
    const stayBRaw = findById(city.staysB, s.stayBId);
    const stayBWanted = stayBRaw && stayBRaw.id !== "none" ? stayBRaw : null;
    const meal = findById(data.mealLevels, s.mealId);
    const transport = findById(city.transports, s.transportId);
    const clinic = findById(city.clinics, s.clinicId) || city.clinics[0];
    const rxPlan = capPlanToClinic(rxPlanFor(country), clinic);
    const rxPatients = rx.patients.matchTravelers ? people : clamp(state.rxPatients, rx.patients.min, people);

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
    // A pre-stay card marked sameAsStayA keeps the whole trip in the main hotel: the prescription day
    // still splits the plan, but no night is booked apart and there is no move on that day.
    const lodgingPre = stayPre.sameAsStayA ? 0 : preNights;
    const availPostNights = nights - lodgingPre;
    const nightsB = stayB ? clamp(Number(s.stayBNights || 1), 1, Math.min(2, Math.max(1, availPostNights - 1))) : 0;
    const nightsA = availPostNights - nightsB;

    const start = addDays(season.startDate, Number(departure.startOffset || 0));
    const end = addDays(start, nights);
    const checkoutPre = addDays(start, lodgingPre);
    const checkoutA = addDays(checkoutPre, nightsA);
    // Every line is an estimate {lo, hi, mean, var} in KRW; [lo, hi] is read as that line's P10-P90.
    const fromLocal = (r, factor = 1) => estimate(r, fx * factor);
    const local = (item, key) => money.of(item, key) || [0, 0];

    // Stays: weekday card price × each night's calendar factor
    const calendar = country.lodgingCalendar;
    const factorsPre = nightFactors(calendar, start, lodgingPre);
    const factorsA = nightFactors(calendar, checkoutPre, nightsA);
    const factorsB = stayB ? nightFactors(calendar, checkoutA, nightsB) : [];
    const stayPreInfo = preStayCost(stayPre, people, factorsPre, money);
    const stayAInfo = stayCost(stayA, roomConfig, people, factorsA, money);
    const stayBInfo = stayB ? stayCost(stayB, roomConfig, people, factorsB, money) : emptyStay();

    // Quotes typed from the live links replace the estimate while their conditions still match.
    const roomsLabel = (info) => `${info.rooms}${info.usesUnits ? "채" : info.kind === "bed" ? "침대" : "실"}`;
    const quoteKeys = {
      flight: [flight.id, start, end].join("|"),
      stayPre: lodgingPre ? [stayPre.id, start, checkoutPre, stayPreInfo.kind, stayPreInfo.rooms, people].join("|") : null,
      stayA: [stayA.id, checkoutPre, checkoutA, stayAInfo.kind, stayAInfo.rooms, people].join("|"),
      stayB: stayB ? [stayB.id, checkoutA, end, stayBInfo.kind, stayBInfo.rooms, people].join("|") : null,
    };
    const quoteContext = {
      flight: `${flight.title} ${formatDate(start)}–${formatDate(end)}`,
      stayPre: lodgingPre ? `${shortTitle(stayPre.title)} ${formatDate(start)}–${formatDate(checkoutPre)} · ${people}명 ${roomsLabel(stayPreInfo)}` : "",
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
      stayPre: lodgingPre ? scale(stayPreInfo.cost, fx) : null,
      stayA: scale(stayAInfo.cost, fx),
      stayB: stayB ? scale(stayBInfo.cost, fx) : null,
    };

    // Flight (KRW)
    const flightLine = applied("flight") ? exact(quotes.flight.krw * people, true) : estimate(flightPerPerson, people);

    // Stays
    const stayPreLine = !lodgingPre ? exact(0) : applied("stayPre") ? exact(quotes.stayPre.krw, true) : estimate(estimates.stayPre);
    const stayALine = applied("stayA") ? exact(quotes.stayA.krw, true) : estimate(estimates.stayA);
    const stayBLine = !stayB ? exact(0) : applied("stayB") ? exact(quotes.stayB.krw, true) : estimate(estimates.stayB);
    const stayLine = sumLines(stayPreLine, stayALine, stayBLine);
    const stayParts = [lodgingPre ? stayPreLine : null, stayALine, stayB ? stayBLine : null].filter(Boolean);
    stayLine.locked = stayParts.every((line) => line.locked);
    stayLine.partial = !stayLine.locked && stayParts.some((line) => line.locked);

    // Lodging / bathing tax (per person per night)
    const taxLocal = sumRanges(
      scale(local(stayPre, "lodgingTax"), people * lodgingPre),
      scale(local(stayA, "lodgingTax"), people * nightsA),
      stayB ? scale(local(stayB, "stayTax"), people * nightsB) : [0, 0]
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
    // Parking at the home airport (KRW), when the city lists options for this flight's origin
    const parkingOptions = parkingOptionsFor(city, flight);
    const parking = findById(parkingOptions, s.parkingId) || parkingOptions[0] || null;
    const parkingLine = parking ? estimate(parkingCost(parking, nights, people)) : exact(0);
    const excursionLine = stayB ? fromLocal(local(stayB, "transferPerPerson"), people) : exact(0);
    // Mobile data (KRW per person), when the city lists plans
    const dataPlan = findById(city.dataPlans, s.dataId) || (city.dataPlans || [])[0] || null;
    const dataLine = dataPlan ? estimate(dataPlan.perPersonKRW, people) : exact(0);

    // Activities: each ticket is its own estimate
    const activityLines = [];
    let activityCount = 0;
    const fullDayLabels = [];
    let cashActivities = [0, 0];
    city.activities.forEach((act) => {
      const value = s.activities[act.id];
      let qty = act.kind === "toggle" ? (value ? 1 : 0) : Number(value || 0);
      if (act.perUnitOf) qty = qty ? Number(s.activities[act.perUnitOf] || 0) : 0;
      if (qty <= 0) return;
      activityCount += 1;

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
      parking: parkingLine,
      stay: stayLine,
      stayTax: stayTaxLine,
      meal: mealLine,
      airport: airportLine,
      transport: transportLine,
      data: dataLine,
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
    const preSummary = lodgingPre ? `${stayPre.short} ${roomsLabel(stayPreInfo)} × ${lodgingPre}박 → ` : "";
    const fullSummary = `${preSummary}${roomSummary}${stayB ? ` + ${stayB.short || "B숙소"} ${nightsB}박` : ""}`;
    const allFactors = [...factorsPre, ...factorsA, ...factorsB];
    const nightFactorText = allFactors.map((factor, i) => `${formatDate(addDays(start, i))} ×${factor.toFixed(2).replace(/0$/, "")}`).join(", ");

    const dutyFreeLimitUSD = Number(rx.dutyFreeLimitUSD || 800);
    const dutyFreeLimitKRW = Number(rx.dutyFreeLimitKRW || 0);
    const perPatientDrugKRW = rxPatients ? rxLine.mean / rxPatients : 0;
    const excessPerPersonKRW = dutyFreeLimitKRW ? Math.max(0, perPatientDrugKRW - dutyFreeLimitKRW) : 0;
    const customs = {
      dutyFreeLimitUSD,
      dutyFreeLimitKRW,
      perPatientDrugKRW,
      excessPerPersonKRW,
      remainingDutyFreeKRW: dutyFreeLimitKRW ? Math.max(0, dutyFreeLimitKRW - perPatientDrugKRW) : 0,
      estTaxSelfKRW: Math.round(excessPerPersonKRW * 0.14),
      estTaxFullKRW: Math.round(excessPerPersonKRW * 0.2),
      isOverLimit: excessPerPersonKRW > 0,
    };

    return {
      cityId,
      country,
      money,
      people,
      nights,
      preNights,
      lodgingPre,
      nightsA,
      nightsB,
      customs,
      startDate: start,
      checkoutPre,
      checkoutA,
      stayPre,
      stayA,
      stayB,
      clinic,
      parking,
      dataPlan,
      activityCount,
      parkingNote: parking ? parkingNoteFor(parking, nights, people) : "",
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

  // An option may mix both: a per-person leg (metro in) and a shared-car leg (taxi out).
  function transferCost(option, people, money) {
    const perVehicle = money.of(option, "perVehicleRoundtrip");
    const vehicles = perVehicle ? scale(perVehicle, Math.ceil(people / Number(option.vehicleCapacity || 4))) : [0, 0];
    return sumRanges(vehicles, scale(money.of(option, "perPersonRoundtrip") || [0, 0], people));
  }

  // Home-airport parking in KRW for the whole trip.
  //   dayBasis "24h": the lot repeats its daily cap every 24 hours, so the trip is `nights` full days
  //     plus a part day (extraKRW) for entering before the flight and leaving after landing.
  //   dayBasis "calendar": the lot charges each calendar day from entry to exit (nights + 1).
  //   onceKRW: per car once (valet fee). One car per vehicleCapacity people.
  function parkingCost(option, nights, people) {
    const cars = parkingCars(option, people);
    const days = option.dayBasis === "calendar" ? nights + 1 : nights;
    const perCar = sumRanges(scale(option.perDayKRW || [0, 0], days), option.extraKRW || [0, 0], option.onceKRW || [0, 0]);
    return scale(perCar, cars);
  }

  function parkingCars(option, people) {
    return option.perDayKRW ? Math.ceil(people / Number(option.vehicleCapacity || 4)) : 0;
  }

  function parkingNoteFor(option, nights, people) {
    const cars = parkingCars(option, people);
    if (!cars) return "주차 없음";
    const days = option.dayBasis === "calendar" ? `${nights + 1}일` : `${nights}일 + 자투리`;
    return `${cars}대 × ${days}`;
  }

  function parkingOptionsFor(city, flight) {
    const all = city.homeParking || [];
    const origin = (flight && flight.from) || "ICN";
    return all.filter((option) => !option.airports || option.airports.includes(origin));
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

  // A clinic that hands out only N weeks per visit (usualMaxWeeks) is priced at N weeks, filling
  // the plan's doses in order, so the quote and the per-month figure match what the clinic gives.
  function capPlanToClinic(plan, clinic) {
    const max = Number(clinic.usualMaxWeeks || 0);
    const total = sum(Object.values(plan.weeks));
    if (!max || total <= max) return plan;
    let left = max;
    const weeks = {};
    Object.entries(plan.weeks).forEach(([dose, w]) => {
      const take = Math.min(w, left);
      if (take > 0) weeks[dose] = take;
      left -= take;
    });
    return { ...plan, weeks, cappedFrom: total };
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

    // Budget bed (dorm / capsule) when used as stayB: priced per bed per night.
    const perBed = money.of(stay, "perBedPerNight");
    if (perBed) {
      return { cost: scale(perBed, people * nightUnits), rooms: people, kind: "bed", usesUnits: false };
    }

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
    // An option that mixes modes can name each leg (metro in, early taxi out).
    const airportIn = (airport && airport.shortIn) || airportLabel;
    const airportOut = (airport && airport.shortOut) || airportLabel;
    const clinic = result.clinic;
    const country = result.country;
    const planText = planTitle(result.rxPlan, country);
    const rxIdx = result.preNights;
    const preShort = result.stayPre.short;
    const postShort = shortTitle(result.stayA.title);
    const morningArrival = departure.arrival === "morning";
    // A midday flight lands in the afternoon: no lunch, but the evening is free.
    const afternoonArrival = departure.arrival === "afternoon";
    const lodgingPre = result.lodgingPre;
    const warnings = [...result.rxAdjust];
    const overflow = [];

    const days = Array.from({ length: dayCount }, (_, i) => {
      const date = addDays(result.startDate, i);
      let night = "";
      if (i < lodgingPre) night = preShort;
      else if (i < lodgingPre + result.nightsA) night = postShort;
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
    arrivalDay.eveningOk = morningArrival || afternoonArrival;

    const departureDay = days[last];
    departureDay.kind = "departure";
    departureDay.cap = 0;
    departureDay.morningOk = Boolean(city.departureLunchOk);
    departureDay.lunchOk = Boolean(city.departureLunchOk);
    departureDay.eveningOk = false;

    const bDay = result.stayB ? result.lodgingPre + result.nightsA : -1;
    if (bDay > 0) {
      days[bDay].kind = "toB";
      days[bDay].cap = 1;
      days[bDay].eveningOk = false;
    }
    // The prescription morning leaves room for one more half-day item. A parcel the front desk takes in
    // during the afternoon (pickupLate) leaves the whole day free; it is collected on coming back.
    if (rxIdx > 0 && days[rxIdx].kind === "open") {
      days[rxIdx].kind = "rx";
      days[rxIdx].cap = clinic.pickupLate ? 2 : 1;
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
    if (clinic.irregular && clinic.openDays.includes(rxWd)) {
      warnings.push({
        scopes: ["clinic"],
        conflict: false,
        text: `${withTopic(clinic.short)} 부정기 휴무가 있습니다. ${formatDate(rxDate)} 진료 가능 여부를 예약 때 확인하세요.`,
      });
    }
    if (clinic.weekendNote && (rxWd === 0 || rxWd === 6)) {
      warnings.push({ scopes: ["clinic"], conflict: false, text: `${formatDate(rxDate)}은 주말이라 ${clinic.weekendNote}` });
    }
    if (clinic.eve && rxIdx === 0 && clinic.eveAhead) {
      warnings.push({
        scopes: ["rx", "clinic"],
        conflict: false,
        text: `택배가 체크인보다 먼저 올 수 있습니다. 호텔에 '도착 전 택배 대리 수령·냉장 보관'을 미리 확인하세요. 하루 늦으면 ${formatDate(addDays(result.startDate, 1))}에 받으면 되니 일정은 그대로 둡니다.`,
      });
    }
    if (clinic.eve && rxIdx === 0 && !clinic.eveAhead) {
      warnings.push({
        scopes: ["rx", "clinic"],
        conflict: true,
        text: `${withTopic(clinic.short)} 전날 주문해야 해서 도착일(Day1) 수령이 안 됩니다. 처방일을 Day2 이후로 바꾸세요.`,
      });
    }
    if (clinic.eveLateNote && rxIdx === 1 && departure.arrival === "night") {
      warnings.push({ scopes: ["rx", "clinic"], conflict: false, text: clinic.eveLateNote });
    }
    // The clinic cannot fill the picked plan: priced at what it gives, and flagged as not matching the plan.
    if (result.rxPlan.cappedFrom) {
      warnings.push({
        scopes: ["rx", "clinic"],
        conflict: true,
        text: `${withTopic(clinic.short)} 한 번에 보통 ${clinic.usualMaxWeeks}주분까지만 처방해 고른 수량(${result.rxPlan.cappedFrom}주분)을 받기 어렵습니다. 금액은 ${planText}(${clinic.usualMaxWeeks}주분) 기준입니다. 3펜 이상은 온라인 카드를 고르세요.`,
      });
    }
    const planWeeks = sum(Object.values(result.rxPlan.weeks));
    if (rx.importLimitWeeks && planWeeks > rx.importLimitWeeks) {
      warnings.push({
        scopes: ["rx"],
        conflict: false,
        text: `반입 수량 확인: ${planText}(${planWeeks}주분)은 기본 6병 안이지만 3개월분(${rx.importLimitWeeks}주)을 넘습니다. 출국 전 관세청(125)에 확인하거나 3펜(12주분)으로 줄이세요.`,
      });
    }
    if (result.customs && result.customs.isOverLimit) {
      warnings.push({
        scopes: ["rx"],
        conflict: false,
        text: `관세·면세 주의: 1인 약값이 약 ${formatManwon(result.customs.perPatientDrugKRW)}로 면세 한도($${result.customs.dutyFreeLimitUSD} · 약 ${formatManwon(result.customs.dutyFreeLimitKRW)})를 초과합니다. 자진신고 시 예상 세액 1인 약 ${formatManwon(result.customs.estTaxSelfKRW)} (30% 감면).`,
      });
    }

    // A data plan on the local network: the sites the travellers are used to do not open.
    if (result.dataPlan && result.dataPlan.blockedNote) {
      warnings.push({ scopes: ["data"], conflict: false, text: result.dataPlan.blockedNote });
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
    // One dinner a night: a dinner item skips days that already have one while another day is free.
    activityQueue("evening").forEach((item) => {
      const open = days.filter((day) => day.eveningOk).sort((a, b) => a.evenings.length - b.evenings.length);
      const noDinnerYet = item.act.dinner ? open.filter((day) => !day.dinner && allowed(item.act, day)) : open;
      place(item, noDinnerYet.length ? noDinnerYet : open, (day) => {
        day.evenings.push(`저녁 ${item.label}`);
        if (item.act.dinner) day.dinner = true;
      });
    });
    // A delivery route is ordered the evening before it arrives.
    if (clinic.eve && rxIdx > 0) days[rxIdx - 1].evenings.push(clinic.eve);
    // An early return flight needs packing and a car booked the night before.
    if (departure.lastEvening && last > 0) days[last - 1].evenings.push(departure.lastEvening);

    const rxSteps = (arrivedToday) => {
      const steps = [];
      const moves = arrivedToday || lodgingPre > 0;
      if (!arrivedToday && lodgingPre > 0) steps.push(`${preShort} 체크아웃 → ${country.luggageRxDay}`);
      steps.push(`처방 · ${clinic.action}`);
      steps.push(moves ? `${postShort} 체크인 · 펜은 객실 냉장고에` : "펜은 바로 객실 냉장고에 (연박이라 이동 없음)");
      return steps;
    };

    days.forEach((day) => {
      const items = [];
      if (day.morning) items.push(day.morning);
      if (day.kind === "arrival") {
        // What to do about mobile data on landing comes first, ahead of the ride into town.
        const landing = items.length;
        const when = morningArrival ? "오전" : afternoonArrival ? "오후" : "밤";
        if (day.rx && clinic.pickupLate) {
          items.push(`${when} ${flight.airport} 도착 → ${airportIn} → ${day.night} 체크인`);
          items.push(`체크인하며 처방 수령 · ${clinic.action}`);
          items.push("펜은 바로 객실 냉장고에");
        } else if (day.rx) {
          items.push(`${when} ${flight.airport} 도착 → ${airportIn}`);
          items.push(...rxSteps(true));
        } else {
          items.push(`${when} ${flight.airport} 도착 → ${airportIn} → ${day.night} 체크인`);
        }
        if (result.dataPlan && result.dataPlan.onArrival) items.splice(landing, 0, result.dataPlan.onArrival);
      } else if (day.kind === "departure") {
        const checkout = `${result.stayB ? result.stayB.short || "B숙소" : postShort} 체크아웃`;
        if (day.lunch) {
          items.push(`${checkout} · ${country.luggageLastDay}`, day.lunch);
          day.lunch = null;
          items.push(`${airportOut} → 귀국 (펜은 기내 휴대)`);
        } else {
          items.push(`${checkout} → ${airportOut} → 귀국 (펜은 기내 휴대)`);
        }
      } else if (day.kind === "rx") {
        if (!clinic.pickupLate) items.push(...rxSteps(false));
      } else if (day.kind === "toB") {
        if (!day.halves.length) items.push("오전 시내 자유");
      } else if (day.main) {
        items.push(day.main);
      }
      // Lunch goes after the morning block: the day's main course, or else its first half-day item.
      const halves = [...day.halves];
      if (day.lunch && !day.main && halves.length) items.push(halves.shift());
      if (day.lunch) items.push(day.lunch);
      items.push(...halves);
      if (day.kind === "rx" && clinic.pickupLate) {
        items.push(`귀가 후 처방 수령 · ${clinic.action}`);
        items.push(lodgingPre > 0 ? `${postShort} 체크인 · 펜은 객실 냉장고에` : "펜은 바로 객실 냉장고에 (연박이라 이동 없음)");
      }
      if (day.kind === "toB") items.push(`오후 ${result.stayB.short || "B숙소"} 이동 · ${result.stayB.includesMeals ? "온천·석식" : "체크인"}`);
      items.push(...day.evenings);
      day.items = items;
    });

    // Pre-trip steps in date order: the clinic's booking step plus the city's own checklist.
    // Each step is { when, text }: when it is due (shown as a column) and what to do.
    const steps = [];
    if (clinic.book) {
      const booking = bookingStep(clinic, rxDate, planText);
      steps.push({ date: addDays(rxDate, -clinic.book.daysBefore), order: 0, when: booking.when, text: booking.text });
    } else {
      // An appointment has no due date of its own; the sooner the better, so it leads the list.
      steps.push({ date: "", order: 0, when: "미리", text: `${clinic.short} ${formatDate(rxDate)} 오전 진료 예약 · ${planText} 재고 확인` });
    }
    // Ordered from home the night before departure, so it lands on arrival day.
    if (clinic.eveAhead && rxIdx === 0) {
      const date = addDays(result.startDate, -1);
      steps.push({ date, order: 99, when: formatDate(date), text: clinic.eveAhead });
    }
    (city.preTrip || []).forEach((item, i) => {
      const date = addDays(result.startDate, -Number(item.daysBefore || 0));
      steps.push({
        date,
        order: i + 1,
        when: item.daysBefore ? `${formatDate(date)}쯤` : formatDate(date),
        text: item.daysBefore ? item.text : `출발일 · ${item.text}`,
      });
    });
    steps.sort((a, b) => (a.date === b.date ? a.order - b.order : a.date < b.date ? -1 : 1));
    const preTrip = steps.map(({ when, text }) => ({ when, text }));
    const money = result.money;
    const cashToCarry = roundUp(result.cash.total[1], money.currency.cashStep);
    preTrip.push({ when: "출발 전", text: `${money.currency.name} 현금 약 ${money.format([cashToCarry, cashToCarry])} 준비 ('처방 준비' 탭에 내역)` });

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

  function taxLabel(country) {
    return country && country.id === "jp" ? "숙박세·입탕세" : "숙박세";
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

  // { price, note }: the price is shown first and stronger, the note after it.
  function describeActivityPrice(act, season, money) {
    const group = money.of(act, "group");
    const peak = season.parkTier === "peak";
    const amount = group || activityPrice(act, peak, money);
    const free = amount[1] === 0;
    // A note that itself says "무료" would only repeat the price.
    const notes = (act.note ? act.note.split(" · ") : []).filter((part) => !(free && part === "무료"));
    if (act.cash) notes.push("현금 위주");
    if (!group && peak && money.of(act, "peakAdult")) notes.push("성수기 등급");
    return { price: free ? "무료" : `${group ? "일행" : "1인"} ${money.format(amount)}`, note: notes.join(" · ") };
  }

  // filter: Booking.com nflt value, e.g. "class=4" for 4-star results only.
  function bookingUrl(query, checkin, checkout, rooms, filter) {
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
    if (filter) params.set("nflt", filter);
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

  // Small amounts (parking) read better to the thousand won than in 만원.
  function formatWonRange(r) {
    const k = (v) => (Math.round(v / 1000) * 1000).toLocaleString("ko-KR");
    return r[0] === r[1] ? `${k(r[0])}원` : `${k(r[0])}-${k(r[1])}원`;
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
  window.TRIP_APP_BRIDGE = {
    storageKey: STORAGE_KEY,
    getState: () => state,
    getResult: (cityId = state.cityId) => compute(cityId),
    selectStayA: (stayId) => {
      const city = cities[state.cityId];
      if (!findById(city.staysA, stayId)) return;
      cityState().stayAId = stayId;
      commit();
    },
    selectStayB: (stayId) => {
      const city = cities[state.cityId];
      if (!findById(city.staysB, stayId)) return;
      cityState().stayBId = stayId;
      commit();
    },
    setStayBNights: (nightsB) => {
      cityState().stayBNights = clamp(Number(nightsB), 1, 2);
      commit();
    },
    reloadFromStorage: () => {
      const loaded = loadState();
      if (!loaded) return false;
      const ui = state.ui;
      Object.assign(state, loaded, { ui });
      render(false);
      return true;
    },
  };
})();
