/* data.js - Da Nang Travel Quote MVP Data (UTF-8)
   - No fetch required (works in file://)
   - KRW ranges (min-max) with typicalKRW added for realism
   - Updated for October 19-24, 2026 travel dates (shoulder season estimates)
   - Prices based on 2025/2026 proxies from Kayak, Booking.com, Numbeo, etc.
   - 1 USD ≈ 1,350 KRW, 1 VND ≈ 0.054 KRW
*/
(() => {
  const AS_OF = "2026-03-04";

  // ---------- Calculation Rules (defaults; engine applies) ----------
  const calculationRules = {
    mealChargeDays: 6,
    transportChargeDays: 5,
    roomCount: 3,
    airportTransferIncludedInTransport: true,
    applyChildRuleForBanaHill: true,
    taxIncluded: { flight: true, stay: false, meal: true, transport: true, activities: true },
    contingencyRate: { min: 0.10, max: 0.15 },
    taxRate: 0.12, // Added for auto tax application on stays/meals
  };

  // ---------- Party Defaults ----------
  const partyDefaults = { adults: 6, children: 2, total: 8, perPersonMode: "average" };

  // ---------- Helpers ----------
  const range = (min, max) => ({ minKRW: min, maxKRW: max });
  const sourceRef = (sourceName, sourceUrl, note = "") => ({ asOf: AS_OF, sourceName, sourceUrl, note });

  // ---------- Options (Cards) ----------
  const options = {
    // A) Flights (updated with 2026 Oct estimates from Kayak/Skyscanner/Expedia)
    flight: [
      {
        id: "direct_lcc",
        title: "직항 - LCC",
        subtitle: "가성비, 수하물/좌석 옵션에 따라 변동 (10월 비수기 프로모션 많음)",
        unit: "perPersonRoundtrip",
        price: range(180000, 350000),
        typicalKRW: 250000,
        sourceRef: sourceRef(
          "Kayak/Skyscanner/Expedia (ICN-DAD Oct 2026 proxies)",
          "https://www.kayak.com/flight-routes/Seoul-SEL/Da-Nang-DAD",
          "왕복 이코노미 기준 (8석 동시, $135-$259 USD proxy)"
        ),
      },
      {
        id: "direct_fsc",
        title: "직항 - FSC",
        subtitle: "서비스 안정, 가격 상단 가능 (Korean Air 등)",
        unit: "perPersonRoundtrip",
        price: range(400000, 600000),
        typicalKRW: 450000,
        sourceRef: sourceRef(
          "Korean Air/Expedia (ICN-DAD Oct 2026 proxies)",
          "https://www.koreanair.com/flights/en/flights-from-seoul-to-da-nang",
          "왕복 이코노미 기준 ($295-$435 USD proxy)"
        ),
      },
      {
        id: "connecting",
        title: "경유",
        subtitle: "가격은 낮을 수 있으나 일정/피로도 증가 (Hanoi 경유 등)",
        unit: "perPersonRoundtrip",
        price: range(120000, 250000),
        typicalKRW: 180000,
        sourceRef: sourceRef(
          "Skyscanner/Trip.com (ICN-DAD Oct 2026 proxies)",
          "https://www.skyscanner.com/routes/sela/dad/seoul-to-da-nang.html",
          "경유 포함 범위 ($48-$98 USD RT proxy)"
        ),
      },
    ],

    // NEW) Room configuration (changes roomCount / stay style)
    roomConfig: [
      {
        id: "rooms_3_standard",
        title: "객실 구성 - 3객실(기본)",
        subtitle: "부모님 1 + 부부 2 (가장 흔함)",
        unit: "config",
        overrides: { roomCount: 3 },
        sourceRef: sourceRef("Assumption (common family setup)", "https://www.booking.com/", "MVP 기본값"),
      },
      {
        id: "rooms_4_split_sleep",
        title: "객실 구성 - 4객실(수면 분리)",
        subtitle: "아이 수면/부부 분리로 컨디션 방어",
        unit: "config",
        overrides: { roomCount: 4 },
        sourceRef: sourceRef("Assumption (comfort-focused setup)", "https://www.booking.com/", "컨디션/수면 우선"),
      },
      {
        id: "residence_2br",
        title: "객실 구성 - 2BR 레지던스(가능 리조트만)",
        subtitle: "거실/주방 + 동선 편함(가격 변동 큼)",
        unit: "config",
        overrides: { roomCount: 2, stayAStyle: "residence_preferred" },
        sourceRef: sourceRef("Hotel room-type varies by resort", "https://www.booking.com/", "가능/불가능은 리조트별 상이"),
      },
      {
        id: "rooms_3_plus_1optional",
        title: "객실 구성 - 3객실 + (필요시 1객실 추가)",
        subtitle: "기본은 3, 컨디션 나쁘면 1 추가",
        unit: "config",
        overrides: { roomCount: 3, roomCountOptionalExtra: 1 },
        sourceRef: sourceRef("Assumption (flex option)", "https://www.booking.com/", "UI에서 토글로 1객실 추가 허용 가능"),
      },
    ],

    // A) Stay A (Da Nang resort) - updated with Oct proxies (taxes excl., add 12%)
    stayA_3nights: [
      {
        id: "hyatt",
        title: "Hyatt Regency Danang",
        subtitle: "가족/키즈풀 강함",
        unit: "perRoomPerNight",
        price: range(300000, 450000),
        typicalKRW: 370000,
        tags: ["kids_pool", "kids_club", "beach_front", "popular"],
        sourceRef: sourceRef("Booking.com (Oct 2025 proxy)", "https://www.booking.com/hotel/vn/hyatt-regency-danang-resort-and-spa.html", "3 rooms, 6A+2C, $220-$330 USD proxy, taxes excl."),
      },
      {
        id: "furama",
        title: "Furama Resort Danang",
        subtitle: "클래식 5성, 부모님 만족도",
        unit: "perRoomPerNight",
        price: range(220000, 350000),
        typicalKRW: 280000,
        tags: ["beach_front", "classic", "parents_friendly"],
        sourceRef: sourceRef("Booking.com (Oct 2025 proxy)", "https://www.booking.com/hotel/vn/furama-resort-danang.html", "$160-$260 USD proxy"),
      },
      {
        id: "sheraton",
        title: "Sheraton Grand Danang",
        subtitle: "초대형 풀, 조용한 편",
        unit: "perRoomPerNight",
        price: range(250000, 380000),
        typicalKRW: 310000,
        tags: ["big_pool", "quiet", "beach_front"],
        sourceRef: sourceRef("Booking.com (Oct 2025 proxy)", "https://www.booking.com/hotel/vn/sheraton-grand-danang-resort.html", "$185-$280 USD proxy"),
      },
      {
        id: "pullman",
        title: "Pullman Danang",
        subtitle: "가성비, 접근성",
        unit: "perRoomPerNight",
        price: range(180000, 300000),
        typicalKRW: 240000,
        tags: ["budget", "beach_front"],
        sourceRef: sourceRef("Booking.com (Oct 2025 proxy)", "https://www.pullman-danang.com/offers/", "$130-$220 USD proxy"),
      },
      {
        id: "intercontinental",
        title: "InterContinental Danang",
        subtitle: "최상급, 가격 상단 큼",
        unit: "perRoomPerNight",
        price: range(500000, 800000),
        typicalKRW: 650000,
        tags: ["luxury", "iconic", "parents_friendly"],
        sourceRef: sourceRef("Booking.com (Oct 2025 proxy)", "https://www.booking.com/hotel/vn/intercontinental-danang-sun-peninsula-resort.html", "$370-$590 USD proxy"),
      },
      {
        id: "premier_village",
        title: "Premier Village Danang (Accor)",
        subtitle: "빌라형/가족 단위에 강함",
        unit: "perRoomPerNight",
        price: range(400000, 650000),
        typicalKRW: 520000,
        tags: ["villa", "private_pool", "beach_front", "family"],
        sourceRef: sourceRef("Booking.com (Oct 2025 proxy)", "https://www.booking.com/hotel/vn/premier-village-danang-resort.en-gb.html", "$295-$480 USD proxy"),
      },
      {
        id: "danang_marriott",
        title: "Da Nang Marriott Resort & Spa",
        subtitle: "풀 다양, 가족친화",
        unit: "perRoomPerNight",
        price: range(280000, 450000),
        typicalKRW: 360000,
        tags: ["family", "big_pool", "beach_front"],
        sourceRef: sourceRef("Marriott (Oct 2025 proxy)", "https://www.marriott.com/hotels/travel/dadmr-danang-marriott-resort-and-spa", "$205-$330 USD proxy"),
      },
      {
        id: "melia_danang",
        title: "Meliá Danang Beach Resort",
        subtitle: "리조트+패밀리 옵션, 적당한 가격대",
        unit: "perRoomPerNight",
        price: range(200000, 350000),
        typicalKRW: 270000,
        tags: ["family", "beach_front", "value"],
        sourceRef: sourceRef("Booking.com (Oct 2025 proxy)", "https://www.booking.com/hotel/vn/melia-danang.html", "$145-$260 USD proxy"),
      },
      {
        id: "naman_retreat",
        title: "Naman Retreat",
        subtitle: "조용/감성, 풀·스파",
        unit: "perRoomPerNight",
        price: range(250000, 400000),
        typicalKRW: 320000,
        tags: ["quiet", "wellness", "beach_front"],
        sourceRef: sourceRef("Booking.com (Oct 2025 proxy)", "https://www.booking.com/hotel/vn/naman-retreat.it.html", "$185-$295 USD proxy"),
      },
      {
        id: "mikazuki",
        title: "Da Nang Mikazuki",
        subtitle: "워터파크/실내풀(가족 체감 큼)",
        unit: "perRoomPerNight",
        price: range(180000, 320000),
        typicalKRW: 240000,
        tags: ["waterpark", "indoor_pool", "kids_pool", "family"],
        sourceRef: sourceRef("Expedia (Oct 2025 proxy)", "https://www.expedia.co.jp/en/Da-Nang-Hotels-Da-Nang-Mikazuki-Japanese-Resorts-Spa.h4790557.Hotel-Information", "$130-$235 USD proxy"),
      },
    ],

    // B) Stay B (Hoi An) - updated with Oct proxies
    stayB_2nights: [
      {
        id: "la_siesta",
        title: "La Siesta Hoi An",
        subtitle: "올드타운 접근, 만족도 높음",
        unit: "perRoomPerNight",
        price: range(140000, 250000),
        typicalKRW: 190000,
        tags: ["oldtown_easy", "popular", "family"],
        sourceRef: sourceRef("Booking.com (Oct 2025 proxy)", "https://www.booking.com/hotel/vn/la-siesta-hoi-an-resort-spa.html", "$100-$185 USD proxy"),
      },
      {
        id: "allegro",
        title: "Allegro Hoi An",
        subtitle: "야시장/올드타운 동선",
        unit: "perRoomPerNight",
        price: range(120000, 220000),
        typicalKRW: 160000,
        tags: ["oldtown_walkable", "value"],
        sourceRef: sourceRef("Booking.com (Oct 2025 proxy)", "https://www.booking.com/hotel/vn/allegro-hoi-an-a-little-luxury-hotel-spa.html", "$90-$160 USD proxy"),
      },
      {
        id: "other",
        title: "기타(4성급 평균)",
        subtitle: "가격 안정, 품질은 케바케",
        unit: "perRoomPerNight",
        price: range(100000, 200000),
        typicalKRW: 140000,
        tags: ["budget"],
        sourceRef: sourceRef("Booking.com Hoi An avg (Oct 2025 proxy)", "https://www.booking.com/city/vn/hoi-an.html", "$75-$145 USD avg proxy"),
      },
      {
        id: "anantara",
        title: "Anantara Hoi An",
        subtitle: "강변/부모님 만족, 올드타운 근접",
        unit: "perRoomPerNight",
        price: range(280000, 450000),
        typicalKRW: 350000,
        tags: ["riverfront", "luxury", "oldtown_easy", "parents_friendly"],
        sourceRef: sourceRef("Booking.com (Oct 2025 proxy)", "https://www.booking.com/hotel/vn/anantara-hoi-an-resort.ko.html", "$205-$330 USD proxy"),
      },
      {
        id: "palm_garden",
        title: "Palm Garden (리조트형)",
        subtitle: "수영장+휴양, 올드타운은 이동",
        unit: "perRoomPerNight",
        price: range(180000, 320000),
        typicalKRW: 240000,
        tags: ["resort", "pool", "quiet"],
        sourceRef: sourceRef("Booking.com (Oct 2025 proxy)", "https://www.booking.com/hotel/vn/palm-garden-resort.html", "$130-$235 USD proxy"),
      },
      {
        id: "silk_marina",
        title: "Hoi An Silk Marina",
        subtitle: "강변/가성비+분위기",
        unit: "perRoomPerNight",
        price: range(130000, 240000),
        typicalKRW: 180000,
        tags: ["riverfront", "value"],
        sourceRef: sourceRef("Booking.com (Oct 2025 proxy)", "https://www.booking.com/hotel/vn/hoi-an-silk-marina-resort-spa.html", "$95-$175 USD proxy"),
      },
      {
        id: "little_riverside",
        title: "Little Riverside",
        subtitle: "올드타운 + 강뷰",
        unit: "perRoomPerNight",
        price: range(150000, 280000),
        typicalKRW: 210000,
        tags: ["riverfront", "oldtown_easy", "boutique"],
        sourceRef: sourceRef("Booking.com (Oct 2025 proxy)", "https://www.booking.com/hotel/vn/little-riverside-hoi-an-a-luxury-hotel-spa.html", "$110-$205 USD proxy"),
      },
    ],

    // Meal levels updated with Numbeo/Vietnam guides 2026
    mealLevel: [
      {
        id: "local",
        title: "식비 - 로컬 위주",
        subtitle: "로컬/반미/커피 중심",
        unit: "perPersonPerDay",
        price: range(20000, 35000),
        typicalKRW: 27000,
        tags: ["budget"],
        sourceRef: sourceRef("Numbeo/Machupicchu (2026 est.)", "https://www.numbeo.com/cost-of-living/in/Da-Nang", "Street $6-10 USD/day proxy"),
      },
      {
        id: "mixed",
        title: "식비 - 혼합",
        subtitle: "로컬+해산물+카페 섞기",
        unit: "perPersonPerDay",
        price: range(30000, 50000),
        typicalKRW: 40000,
        tags: ["balanced"],
        sourceRef: sourceRef("Numbeo/Wanderonless (2026 est.)", "https://www.numbeo.com/cost-of-living/in/Da-Nang", "Mixed $12-25 USD/day"),
      },
      {
        id: "restaurant",
        title: "식비 - 레스토랑 위주",
        subtitle: "관광지/주류 비중",
        unit: "perPersonPerDay",
        price: range(45000, 80000),
        typicalKRW: 60000,
        tags: ["premium"],
        sourceRef: sourceRef("Numbeo/Vietnamairlines (2026 est.)", "https://www.numbeo.com/cost-of-living/in/Da-Nang", "Restaurant $15-30 USD/day"),
      },
      {
        id: "mixed_light_drink",
        title: "식비 - 혼합(술 적게)",
        subtitle: "술/바 비중 낮춤",
        unit: "perPersonPerDay",
        price: range(25000, 45000),
        typicalKRW: 35000,
        tags: ["balanced"],
        sourceRef: sourceRef("Assumption (mixed, low alcohol)", "https://www.numbeo.com/cost-of-living/in/Da-Nang", "혼합에서 술 비중 낮춘 변형"),
      },
      {
        id: "seafood_focus",
        title: "식비 - 해산물 집중",
        subtitle: "해산물 2-3회 + 주류 약간",
        unit: "perPersonPerDay",
        price: range(40000, 70000),
        typicalKRW: 55000,
        tags: ["parents_friendly"],
        sourceRef: sourceRef("Assumption (seafood heavy)", "https://www.numbeo.com/cost-of-living/in/Da-Nang", "해산물/주류 포함 상단 확장"),
      },
    ],

    // Transport updated with TaxiBambino/Danangtransfer 2026
    transport: [
      {
        id: "grab_taxi",
        title: "이동 - 그랩/택시",
        subtitle: "필요할 때 호출(공항 포함 가정)",
        unit: "perGroupPerDay",
        price: range(50000, 120000),
        typicalKRW: 80000,
        airportIncluded: true,
        sourceRef: sourceRef("Danangtransfer/Taxibambino", "https://danangtransfer.vn/en/da-nang-airport-transfer-guide-2026-cost-car-options-booking-tips", "Group 8, van x1.5, 150k-400k VND/trip proxy"),
      },
      {
        id: "car_driver_1day",
        title: "이동 - 차량+기사(1일)",
        subtitle: "일정 빡빡한 날 편함(공항 포함 가정)",
        unit: "perGroupPerDay",
        price: range(100000, 200000),
        typicalKRW: 150000,
        airportIncluded: true,
        sourceRef: sourceRef("Taxibambino", "https://www.taxibambino.com/single-post/taxi-da-nang-a-price-and-booking-guide", "Van 500k-800k VND/day proxy"),
      },
      {
        id: "tour_pickup",
        title: "이동 - 투어 픽업 위주",
        subtitle: "투어 포함 이동 + 잔잔한 택시",
        unit: "perGroupPerDay",
        price: range(40000, 90000),
        typicalKRW: 60000,
        airportIncluded: true,
        sourceRef: sourceRef("Assumption (tour pickup bundling)", "https://www.welcomepickups.com/da-nang/airport-to-hoi-an/", "잔여 이동비만"),
      },
      {
        id: "van_package",
        title: "이동 - 8인 밴 패키지",
        subtitle: "짐 많고 이동 잦으면 편함",
        unit: "perGroupPerDay",
        price: range(150000, 280000),
        typicalKRW: 200000,
        airportIncluded: true,
        sourceRef: sourceRef("Taxibambino (van hire)", "https://www.taxibambino.com/single-post/taxi-da-nang-a-price-and-booking-guide", "Full day for 8, Oct stable"),
      },
    ],

    // Activities updated with Ba Na Hills/Hoiandaytrip/Klook 2026
    activities: {
      nightMarketVisits: {
        id: "nightMarketVisits",
        title: "야시장",
        unit: "perGroupPerUnit",
        price: range(20000, 50000),
        typicalKRW: 30000,
        defaultQty: 1,
        minQty: 0,
        maxQty: 2,
        sourceRef: sourceRef("Hoi An night market tips", "https://www.vietnamandcambodiatours.com/travel-tips/the-night-market-in-hoi-an", "Group per visit, food incl."),
      },
      massageSessions: {
        id: "massageSessions",
        title: "마사지(60분)",
        unit: "perPersonPerUnit",
        price: range(15000, 35000),
        typicalKRW: 25000,
        defaultQty: 1,
        minQty: 0,
        maxQty: 2,
        sourceRef: sourceRef("Art Spa/Klook (2026 est.)", "https://artspahoian.com/services/", "200k-500k VND proxy"),
      },
      banaHill: {
        id: "banaHill",
        title: "바나힐(입장권)",
        unit: "perPersonPerUnit",
        price: range(40000, 60000),
        typicalKRW: 50000,
        defaultEnabled: false,
        sourceRef: sourceRef("Banahillstickets/Junglebosstours (2026)", "https://banahillstickets.com/updated-ba-na-hills-2026", "Adult 950k VND, child 750k VND proxy (~51k/40k KRW)"),
      },
      seafoodDinner: {
        id: "seafoodDinner",
        title: "해산물 디너(1회)",
        unit: "perGroupPerUnit",
        price: range(150000, 300000),
        typicalKRW: 220000,
        defaultQty: 1,
        minQty: 0,
        maxQty: 2,
        sourceRef: sourceRef("Numbeo/Vietnamstory (group 8)", "https://www.numbeo.com/cost-of-living/in/Da-Nang", "2.5M-5.5M VND proxy"),
      },
      cafeDessert: {
        id: "cafeDessert",
        title: "카페/디저트(1회)",
        unit: "perGroupPerUnit",
        price: range(30000, 70000),
        typicalKRW: 50000,
        defaultQty: 1,
        minQty: 0,
        maxQty: 3,
        sourceRef: sourceRef("Assumption (group cafe spend)", "https://www.numbeo.com/cost-of-living/in/Da-Nang", "가족 카페 1회"),
      },
      basketBoat: {
        id: "basketBoat",
        title: "호이안 바구니보트(1회)",
        unit: "perGroupPerUnit",
        price: range(40000, 100000),
        typicalKRW: 60000,
        defaultQty: 0,
        minQty: 0,
        maxQty: 1,
        sourceRef: sourceRef("Assumption (Hoi An basket boat)", "https://www.booking.com/city/vn/hoi-an.html", "투어 형태/인원 변동"),
      },
      indoorPlanB: {
        id: "indoorPlanB",
        title: "실내 플랜B(키즈카페/몰)",
        unit: "perGroupPerUnit",
        price: range(0, 60000),
        typicalKRW: 30000,
        defaultQty: 0,
        minQty: 0,
        maxQty: 2,
        sourceRef: sourceRef("Assumption (rainy-day indoor)", "https://www.booking.com/city/vn/da-nang.html", "비 오는 날 대비"),
      },
    },

    activityPacks: [
      { id: "pack_relax", title: "팩 - 휴식", subtitle: "마사지 2 + 야시장 1", apply: { massageSessions: 2, nightMarketVisits: 1, banaHill: false },
        sourceRef: sourceRef("Preset pack", "https://www.booking.com/", "초보용 빠른 조립") },
      { id: "pack_family_day", title: "팩 - 가족 데이", subtitle: "바나힐 ON + 야시장 1", apply: { banaHill: true, nightMarketVisits: 1 },
        sourceRef: sourceRef("Preset pack", "https://www.booking.com/", "아이 '오오' 포인트") },
      { id: "pack_parents", title: "팩 - 부모님 만족", subtitle: "해산물 1 + 카페 1", apply: { seafoodDinner: 1, cafeDessert: 1 },
        sourceRef: sourceRef("Preset pack", "https://www.booking.com/", "부모님 체감 만족 강화") },
    ],
  };

  // ---------- Fare Rules (children) ----------
  const fareRules = {
    flight: { childSeat: { mode: "same_as_adult" } },
    activities: {
      banaHill: { childPriceVsAdult: 0.8, eligible: "height_1m_to_1_39m", freeUnder: "height_under_1m" },
      massageSessions: { mode: "no_discount_assumed" },
      nightMarketVisits: { mode: "group_spend" },
      seafoodDinner: { mode: "group_spend" },
      cafeDessert: { mode: "group_spend" },
      basketBoat: { mode: "group_spend" },
      indoorPlanB: { mode: "group_spend" },
    },
  };

  // ---------- Scenario Presets ----------
  const scenarioPresets = [
    {
      id: "preset_balanced",
      title: "기본(혼합/하얏트/호이안)",
      selected: {
        flightId: "direct_lcc",
        roomConfigId: "rooms_3_standard",
        stayAId: "hyatt",
        stayBId: "la_siesta",
        mealLevelId: "mixed",
        transportId: "grab_taxi",
        activities: { nightMarketVisits: 1, massageSessions: 1, banaHill: false, seafoodDinner: 1, cafeDessert: 1, basketBoat: 0, indoorPlanB: 0 },
      },
    },
    {
      id: "preset_budget",
      title: "가성비(풀만/기타/로컬)",
      selected: {
        flightId: "direct_lcc",
        roomConfigId: "rooms_3_standard",
        stayAId: "pullman",
        stayBId: "other",
        mealLevelId: "local",
        transportId: "grab_taxi",
        activities: { nightMarketVisits: 1, massageSessions: 0, banaHill: false, seafoodDinner: 0, cafeDessert: 1, basketBoat: 0, indoorPlanB: 0 },
      },
    },
    {
      id: "preset_waterpark_safe",
      title: "워터파크 안정(미카즈키/실내플랜B)",
      selected: {
        flightId: "direct_lcc",
        roomConfigId: "rooms_3_standard",
        stayAId: "mikazuki",
        stayBId: "allegro",
        mealLevelId: "mixed_light_drink",
        transportId: "van_package",
        activities: { nightMarketVisits: 2, massageSessions: 1, banaHill: false, seafoodDinner: 1, cafeDessert: 2, basketBoat: 0, indoorPlanB: 1 },
      },
    },
  ];

  // ---------- Export (no modules; file:// safe) ----------
  window.TRAVEL_DATA = {
    meta: {
      locale: "ko-KR",
      currency: "KRW",
      asOf: AS_OF,
      region: "Da Nang / Hoi An (Oct 19-24, 2026)",
      notes: [
        "항공 옵션(A)은 기존 그대로 유지, 2026 Oct 추정 업데이트.",
        "가격은 모두 min-max 범위(KRW) + typicalKRW.",
        "숙박은 perRoomPerNight (taxes excl., calculationRules.taxRate 적용 권장), 이동은 perGroupPerDay, 식비는 perPersonPerDay.",
        "결과는 ‘평균 1인’(총액/총인원) 계산을 권장.",
        "Ranges narrowed by 30-50% for realism based on proxies.",
      ],
    },
    calculationRules,
    partyDefaults,
    fareRules,
    options,
    scenarioPresets,
  };
})();
