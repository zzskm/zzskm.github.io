/* data.js - Shanghai trip from Cheongju (CJJ), 2026-11-28 (Sat) - 12-01 (Tue) draft, with a Mounjaro prescription stop, UTF-8
   - Destination and home airport are settled: Spring Airlines 9C CJJ <-> PVG, driving to Cheongju airport (parking card)
   - One day is the prescription day (a Taobao/JD cold parcel delivered to the hotel, or an in-person visit)
   - The whole stay is one 4-star hotel with a staffed front desk / concierge so the parcel is received for us;
     the pre-stay card "same_hotel" keeps the nights before the prescription day in that same hotel
   - No fetch required (works in file://)
   - Local prices are ranges [min, max] in CNY; flights are KRW ranges [min, max]
   - Engine converts CNY -> KRW with the fx option picked for CNY
   - Each [min, max] is read as that item's P10-P90 estimate; the engine adds items as
     independent estimates (variances add), so the total band is narrower than sum(min)-sum(max)
   - Stay prices are early-December weekday (Sun-Thu night) rates; lodgingCalendar scales each night
   - All prices are planning estimates (proxy) as of AS_OF. Check live prices before booking.
*/
(() => {
  const AS_OF = "2026-11-18";

  const range = (min, max) => [min, max];
  const sourceRef = (sourceName, sourceUrl, note = "") => ({ asOf: AS_OF, sourceName, sourceUrl, note });

  // ---------- Shared sources ----------
  const SRC = {

    // ---------- Mounjaro prescription ----------
    rxImport2: sourceRef(
      "경북도민일보 - 해외 처방분 최대 3개월분 반입 허용",
      "https://www.hidomin.com/news/articleView.html?idxno=728996",
      "자가치료 목적만 허용하고, 판매·대리구매용 대량 반입은 안 됩니다. 3개월분을 반복해 들여오는 것은 취지에 맞지 않는다는 공동 설명도 있습니다(교차 확인용)."
    ),
    rxSafety: sourceRef(
      "인사이트코리아 - 일본 처방 마운자로, 안전 책임은 환자 몫",
      "https://www.insightkorea.co.kr/news/articleView.html?idxno=258855",
      "일본에서 체중 감량 목적 처방은 허가 외 사용(자유진료)입니다. 자가치료용으로 반입한 약은 국내 부작용 피해구제 대상이 아닙니다."
    ),
    rxPriceKr: sourceRef(
      "데일리팜 - 마운자로 약국 판매가 31~35만원대",
      "https://www.dailypharm.com/Users/News/NewsView.html?ID=326037",
      "4주분 국내 공급가는 2.5mg 27.8만원 · 5mg 36.9만원입니다. 2.5mg 판매가는 29~35만원입니다. 5mg 판매가 37~45만원은 공급가로 추정한 값입니다."
    ),
    rxPriceKr75: sourceRef(
      "닥터나우 - 마운자로 용량별 한 달 비용·최저가",
      "https://doctornow.co.kr/content/magazine/35248cf7505d4411a1fc4d9a8173ada9",
      "4펜(4주분) 최저가는 2.5mg 27.2만원 · 5mg 36만원 · 7.5mg 51만원 · 10mg 51만원입니다(2026-11-12 검수). 같은 지역 약국끼리도 몇만 원씩 차이 납니다. 7.5mg 판매가 51-60만원은 최저가에 약국 간 차이를 더한 추정입니다."
    ),
    rxStorage: sourceRef(
      "신주쿠역앞 클리닉(新宿駅前クリニック) - 마운자로 보관법(マンジャロ 保管方法)",
      "https://www.shinjyuku-ekimae-clinic.info/naika/mounjaro.html",
      "2-8℃에서 빛을 피해 냉장 보관합니다. 냉장이 어려우면 30℃ 이하 실온에서 누적 21일까지 둘 수 있습니다. 얼리면 안 됩니다."
    ),

    // ---------- China ----------
    fxCny: sourceRef(
      "ECB 기준환율 (Frankfurter API)",
      "https://api.frankfurter.dev/v1/latest?from=CNY&to=KRW",
      "2026-11-12 기준 1위안 = 200.07원입니다. 카드·알리페이 수수료는 별도입니다."
    ),
    rxImportScope: sourceRef(
      "경향신문 - 위고비·마운자로 해외 처방약, 이제 직접 들고 온다",
      "https://www.khan.co.kr/article/202611112104015/",
      "허용 유형에 '해외여행 중 처방받아 산 약'이 들어갑니다(나라 제한 없음). 현지 규제기관이 정식 허가한 약을 그 나라 의료체계에 따라 처방받아 산 경우여야 합니다. 국내에서 주문하는 직구는 인정하지 않습니다. 식약처는 별도 서류 제출 의무가 없다고 밝혔습니다."
    ),
    cnVisa: sourceRef(
      "헤럴드경제 - 중국, 한국·일본 등 무비자 조치 내년 말까지 연장",
      "https://www.heraldk.com/article/2025110303430536138",
      "한국 일반여권 무비자가 2026-12-31까지 연장됐습니다. 30일 이내 체류이고, 관광·비즈니스·친지 방문·경유가 대상입니다."
    ),
    cnPrice: sourceRef(
      "투중망(投中网) - 비만약 시장 판도 변화, 터제파타이드 값 80% 인하(减肥药江湖变天，替尔泊肽打2折)",
      "https://m.chinaventure.com.cn/news/111-20260119-389831.html",
      "2026-01-01부터 3갑 병원(三甲医院) 4회분(4주) 가격은 2.5mg 324.1위안 · 5mg 551위안 · 7.5mg 751.6위안 · 10mg 936.7위안입니다. 중국 제품은 4회용 펜입니다(2.4ml:10mg = 2.5mg × 4회). 1월 온라인몰은 2.5mg 495.6-599위안 · 5mg 879위안이었습니다."
    ),
    cnIndication: sourceRef(
      "신화망(新华网) - 생활 관찰: 감량·지질 개선 주사 가격 인하, 주사제 기능은 가려 써야(生活观察丨减重降脂针降价，针剂功能需甄别)",
      "http://www.news.cn/20260423/ad246e932dc94ab6ae1c4921c99a3e0f/c.html",
      "터제파타이드 감량 적응증은 BMI 28 이상, 또는 24 이상이면서 체중 관련 동반질환이 있는 경우입니다. 내분비과·감량대사외과 외래에서 혈액검사로 이차성 비만을 배제한 뒤 처방합니다. 감량 목적은 전액 자비이고, 의료보험은 2형 당뇨에만 적용됩니다."
    ),
    cnRule: sourceRef(
      "중국신문망(中国新闻网) - 새 규정 시행, '다이어트 신약' 아직 쉽게 살 수 있나(新规落地，“减肥神药”还能轻松购买吗)",
      "https://www.chinanews.com.cn/jk/2026/05-19/10624228.shtml",
      "2026-05-15 시행된 약품관리법 실시조례에 따라 약국은 처방전이 있어야 처방약을 팝니다. 기자가 돌아본 난징(南京) 약국들은 병원 의사의 종이 처방전 원본(발급 3일 이내, 용량·수량 일치)만 받고 인터넷 처방은 받지 않았습니다. 온라인몰에서는 문진 항목만 골라도 여전히 전자처방이 나옵니다."
    ),
    cnOnline: sourceRef(
      "텐센트 뉴스(腾讯新闻) - 즉석 검증: 인기 감량 주사 온라인 판매 난맥상(马上测｜网红减重针网销乱象)",
      "https://news.qq.com/rain/a/20260604A06JEZ00",
      "개정 조례상 세마글루타이드·터제파타이드 주사는 전자상거래에서 감량 적응증으로 팔 수 없습니다. 그런데도 타오바오(淘宝)의 알리건강 대약방(阿里健康大药房), 징둥(京东), 메이퇀(美团) 모두 '2형 당뇨'나 '고혈당 동반 비만'을 고르고 '확진받았고 써 본 약'이라고 서약하면 1분 안팎에 전자처방이 나왔습니다(2026-06-03 확인). 병이 없는데 이를 고르면 허위 문진이라고 지적합니다."
    ),
    cnOnlineKr: sourceRef(
      "조선비즈(네이트) - 일본 '스시자로' 이어 중국 '마라자로'까지",
      "https://m.news.nate.com/view/20261112n27873",
      "11/12 보도된 한국인 후기입니다. 징둥은 여권과 현지 전화번호로 처방받아 당일 호텔에서 받았고, 타오바오는 채팅 상담 뒤 처방이 나왔습니다. 밤 11시 전에 주문하면 다음 날 오후 3시까지 아이스박스로 오고, 가격은 국내의 1/4 수준입니다. 진품 여부와 보관 상태를 확인하기 어렵다는 지적도 있습니다."
    ),
    cnColdChain: sourceRef(
      "메이카 포럼(美卡论坛) - 터제파타이드(替尔泊肽) 전액 자비 구매 기록 (2026-07)",
      "https://www.uscardforum.com/t/topic/519954",
      "40mg 펜(1회 10mg)은 온라인에서 1,030-1,500위안이고, 작성자는 알리건강 직영에서 1,127위안에 3펜을 샀습니다. 알리건강·징둥 직영 약국은 순펑(顺丰) 콜드체인 직송에 대면 개봉이고, 싼 상점은 일반 택배에 아이스팩만 넣습니다. 3갑 병원은 혈액·갑상선 검사(약 500위안) 뒤 처방했습니다. 출국 때 세관 질문은 없었습니다(개인 후기)."
    ),
    rxPriceTen: sourceRef(
      "경인일보 - 일본·중국 '비만약 원정' 열풍",
      "https://www.kyeongin.com/article/1774657",
      "마운자로 10mg 4주분은 한국 50만원대 중반, 일본(보험 적용) 30만원대, 중국 20만원대입니다. 반입은 기본 6병이고, 6병을 넘으면 3개월 복용량 이내입니다."
    ),
    cnAlipay: sourceRef(
      "Wander in China - 외국인용 알리페이 안내(Alipay guide for foreigners) (2026)",
      "https://www.wanderinchina.com/survival-guide/payment/alipay/",
      "해외 Visa·Mastercard를 연결한 결제는 건당 200위안 이하면 무료이고, 넘으면 결제액 전체에 수수료 3%가 붙습니다. 카드사 해외 수수료는 별도입니다."
    ),
    cnPhoneSim: sourceRef(
      "China Neighbor - 전화번호 있는 중국 eSIM (2026-09, 10-07 갱신)",
      "https://chinaneighbor.com/ko/guide/essentials/china-esim-with-phone-number",
      "여행용 eSIM(Airalo·Holafly·Saily·Nomad)은 모두 데이터 전용이라 +86 번호가 없고 문자 인증을 못 받습니다. 번호가 딸린 eSIM은 홍콩 통신사 부가번호(CUniq HK$48/30일 + HK$10/월, 3HK HK$19/월)뿐입니다. 본토 3사 전화 eSIM은 2025-10 상용 시험 승인을 받았지만 매장에서 여권으로 등록해야 합니다."
    ),
    cnPayLimit: sourceRef(
      "상하이시 정부 - 해외 은행카드로 결제하기(Pay with overseas bank cards) (2026-09-21)",
      "https://english.shanghai.gov.cn/en-Individuals-BankingandPayments-Payments/20260921/c2c94d06a0454c8fa05386b80d0ae865.html",
      "해외 카드 연동 한도는 건당 5,000달러·연 50,000달러입니다. 200위안 이하는 무료이고, 넘으면 결제액 전체의 3%가 붙습니다. ATM 인출은 건당 3,000위안까지입니다. 해외 발급 카드는 로고가 붙은 가맹점과 일부 택시에서 쓸 수 있습니다."
    ),
    cnPayGuide: sourceRef(
      "Homeground China - 중국 여행 결제 2026 (2026-08-10)",
      "https://homegroundchina.com/ko/guides/how-to-pay-in-china-as-a-tourist",
      "알리페이·위챗페이에 해외 카드를 연결하고, 실물 카드와 현금은 백업으로 둡니다. 위챗페이는 200위안 초과 결제에 3%가 붙습니다(텐페이 2026-01-15 공지). 2026-12-31까지 해외 카드를 처음 등록하면 90일간 하루 1,000위안까지 수수료가 면제됩니다."
    ),
    cnPayTest: sourceRef(
      "Private China Journeys - 중국 결제 실사용 테스트 (2026-08-22, 09-30 재검토)",
      "https://privatechinajourneys.com/guides/china-payments-tested-2026",
      "2026-08 테스트에서 알리페이 결제 성공률은 약 95%였고, 나머지는 위챗페이로 해결됐습니다. 애플페이·구글페이는 해외 카드로 결제하면 단말기에서 거절되는 곳이 많아 QR 위주로 준비합니다."
    ),
    cnPayWechat: sourceRef(
      "The China Door - 외국인용 알리페이·위챗페이 안내(Alipay and WeChat Pay for Foreigners) (2026-10-29 확인)",
      "https://thechinadoor.com/practical/payments/",
      "위챗페이 해외 카드 한도는 건당 6,500위안·월 5만위안·연 6.5만위안입니다. 알리페이는 계정별 한도를 앱에 표시합니다. 카드는 앱 안에서 여권 인증을 마친 뒤 등록합니다."
    ),
  };

  // ---------- Internet (the Great Firewall and which SIM gets past it) ----------
  const NET = {
    guide: sourceRef(
      "ChinaTours - 중국 인터넷 접속 가이드(A Traveler's Ultimate Guide to Accessing the Internet in China, 2026-03-24 갱신)",
      "https://www.chinatours.com/travellers-guide-access-internet-china",
      "국제 로밍과 여행용 eSIM은 데이터가 해외로 라우팅돼 VPN 없이 구글·인스타그램·지메일·유튜브가 된다고 설명합니다. 현지 유심은 만리방화벽 안쪽이라 구글·지메일·인스타그램이 안 되고, 호텔 와이파이에 기대려면 입국 전에 VPN을 깔아야 합니다. 구글 지도는 좌표계 차이로 위치가 부정확합니다."
    ),
    roaming: sourceRef(
      "팔글(Palgle) - 중국에서 구글 접속하는 방법: eSIM·VPN·로밍 비교 (2026-06-18)",
      "https://www.palgle.com/2026/06/18/truth-of-china-google-url/",
      "국내 통신사 로밍은 국내 통신망을 거쳐 나가므로 구글·유튜브·카카오톡이 제약 없이 작동하고, 해외 데이터 eSIM도 홍콩·한국 등 해외 망을 경유해 검열 대상에서 빠진다고 설명합니다. 현지 와이파이에 연결하면 다시 막힙니다. 블로그 글이라 통신사 공식 확인은 아닙니다."
    ),
    naver: sourceRef(
      "트립닷컴 - 중국 네이버 접속 방법 (2025-09-23)",
      "https://kr.trip.com/guide/china/%EC%A4%91%EA%B5%AD+%EB%84%A4%EC%9D%B4%EB%B2%84.html",
      "현지 와이파이로는 네이버에 접속되지 않았고, eSIM으로는 뉴스 검색·지도·카페 리뷰까지 열렸다는 후기입니다. 구글·유튜브·인스타그램도 차단 대상으로 듭니다. eSIM 판매 페이지를 겸한 글입니다."
    ),
    naverBlock: sourceRef(
      "YTN - 중국에서 네이버 접속 차단 (2023-05-24)",
      "https://www.ytn.co.kr/_ln/0104_202305241046168198",
      "2023-05 말부터 중국 전역에서 VPN 없이는 네이버에 접속되지 않았고, 주중대사관은 차단 장기화를 우려했습니다. 2018-10에는 네이버 블로그·카페가, 2019-01에는 다음이 차단됐습니다. 2026년 현재 상태를 확인한 공식 자료는 찾지 못했습니다."
    ),
    caution: sourceRef(
      "naruinfo - 중국 인터넷 2026: 차단 앱·출발 전 준비",
      "https://naruinfo.com/ko/%EC%A4%91%EA%B5%AD-%EC%9D%B8%ED%84%B0%EB%84%B7-2026-%EC%B0%A8%EB%8B%A8-%EC%95%B1-vpn-%EC%82%AC%EC%9A%A9%EB%B2%95-%EC%B6%9C%EB%B0%9C-%EC%A0%84-%EC%A4%80%EB%B9%84%EC%82%AC%ED%95%AD-%EC%99%84%EC%A0%84/",
      "차단 목록에 유튜브·구글·인스타그램·카카오톡·라인을 듭니다. '모든 중국 eSIM이 방화벽을 우회하는 것은 아니다'라며 구매 전 홍콩 네트워크 경유 여부를 확인하라고 합니다. 한국 통신사 로밍은 대부분 차단이 유지된다고 적어 다른 자료와 엇갈립니다. 그래서 로밍도 통신사에 확인하도록 안내했습니다."
    ),
    ktRoaming: sourceRef(
      "KT 로밍 - 중국/일본 알뜰 로밍",
      "https://m.globalroaming.kt.com/product/data/cjdrg1",
      "5일 25,000원(부가세 포함)에 데이터 3GB(소진 후 400Kbps)와 음성 30분입니다. 차단 사이트 접속 여부는 페이지에 없습니다. 다른 통신사와 상품은 요금이 다릅니다."
    ),
  };

  // 중국 온라인 구매 → 호텔 수령. 도시와 무관하게 같은 조건이고 문진 서약이 있음
  // 메이퇀(美团买药)은 중국 현지 계좌가 없으면 가입·결제가 안 돼 후보에서 제외
  // 4주분(펜 1개) 가격. d10 = 40mg 펜
  const CN_ONLINE_PRICE = { d25: range(430, 600), d5: range(700, 900), d10: range(1030, 1500) };
  const CN_ONLINE_PREP = [
    "'2형 당뇨'나 '고혈당 동반 비만' 진단이 없으면 병원 대면 카드를 고르세요. 5/15부터 감량 목적 온라인 판매가 금지돼, 문진에서 이 진단을 받았고 써 본 약이라고 서약해야 처방이 나옵니다(진단 없이 서약하면 허위 문진)",
    "결제 전에 고른 펜 수가 한 주문에 담기는지 확인하세요. 1회 구매 수량에 제한이 있을 수 있습니다",
    "처방일은 병원이 여는 날로 잡으세요. 여권 실명 등록은 공식 안내가 없어(징둥에서 여권 + 현지 번호로 됐다는 후기만 있음), 막히면 바로 병원으로 가야 합니다",
    "받으면 아이스팩이 차가운지, 펜이 얼지 않았는지, 상자 봉인과 유효기간을 확인하세요",
    "전자처방전·주문 내역 화면과 영수증(发票)을 저장하세요. 한국 반입 기준이 '그 나라 의료체계에 따른 처방·구매'라 병원 처방전보다 증빙이 약합니다",
  ];
  const cnOnlineClinics = () => [
    {
      id: "taobao_cold",
      pickupLate: true,
      title: "타오바오 · 알리건강 대약방(阿里健康大药房)",
      subtitle: "온라인 문진 → 주문 다음 날 호텔로 냉장 택배 · 중국 번호 없이 가능",
      short: "타오바오 냉장택배",
      mode: "delivery",
      eligibility: "2형 당뇨·고혈당 진단이 있어야 합니다 (감량 목적 온라인 판매 금지)",
      openDays: [0, 1, 2, 3, 4, 5, 6],
      hours: "밤 11시 전 주문 · 다음 날 오후 도착(후기 기준)",
      per4CNY: CN_ONLINE_PRICE,
      estimatedDoses: ["d10"],
      shipCNY: range(0, 0),
      cashPart: "none",
      book: { daysBefore: 3, text: "타오바오 가입 · 알리페이에 해외 카드 등록 → 알리건강 대약방(阿里健康大药房)에서 재고·가격 확인" },
      eveAhead: "밤 11시 전(중국 시각 · 한국 자정 전) 한국에서 타오바오 주문 → 배송지는 상하이 호텔 중국어 주소 + 前台代收 · 받는 사람은 예약자 여권 영문 이름 · 다음 날 오후 도착(후기 기준)",
      eve: "밤 11시 전 타오바오 주문 → 배송지는 묵고 있는 호텔 · 받는 사람 여권 영문 이름 · 주소 끝에 前台代收 (프런트에 냉장 보관 부탁)",
      eveLateNote: "밤에 도착하면 착륙하자마자 밤 11시 전에 주문하세요(마감은 후기 기준). 놓치면 하루 늦게 오니 처방일을 Day3로 옮기세요.",
      action: "호텔 프런트에서 냉장 택배 수령 · 봉인·아이스팩 확인",
      payment: "앱에서 알리페이 선결제(해외 Visa·Master 연결) · 현금 필요 없음",
      prep: [
        "알리건강 대약방(阿里健康大药房) 같은 플랫폼 직영 판매자에게서만 사세요. 직영은 순펑(顺丰) 콜드체인으로 보내고, 개인 상점·구매대행은 위조품과 보관 사고 위험이 큽니다",
        ...CN_ONLINE_PREP,
      ],
      link: { label: "타오바오 · 알리건강 대약방(阿里健康大药房) 검색", href: "https://world.taobao.com/" },
      sourceRef: SRC.cnOnline,
      sourceRef2: SRC.cnOnlineKr,
    },
    {
      id: "jd_cold",
      pickupLate: true,
      title: "징둥(京东) 직영 약국",
      subtitle: "온라인 문진 → 당일~다음 날 호텔로 아이스박스 · 여권 + 중국 휴대폰 번호 필요",
      short: "징둥 콜드체인",
      mode: "delivery",
      eligibility: "2형 당뇨·고혈당 진단이 있어야 합니다 (감량 목적 온라인 판매 금지)",
      openDays: [0, 1, 2, 3, 4, 5, 6],
      hours: "밤 11시 전 주문 · 당일 또는 다음 날 오후 3시까지 도착(후기 기준)",
      per4CNY: CN_ONLINE_PRICE,
      estimatedDoses: ["d10"],
      shipCNY: range(0, 0),
      cashPart: "none",
      book: { daysBefore: 3, text: "징둥 앱 가입(여권) · 알리페이·위챗페이 등록 → 징둥건강(京东健康)에서 무펑다(穆峰达) 재고·가격 확인" },
      eveAhead: "밤 11시 전(중국 시각 · 한국 자정 전) 한국에서 징둥 주문 → 배송지는 상하이 호텔 중국어 주소 + 前台代收 · 받는 사람은 예약자 여권 영문 이름 · 중국 번호가 없으면 주문이 막힐 수 있음",
      eve: "밤 11시 전 징둥 주문 → 배송지는 묵고 있는 호텔 · 받는 사람 여권 영문 이름 · 주소 끝에 前台代收 (프런트에 냉장 보관 부탁)",
      eveLateNote: "밤에 도착하면 착륙하자마자 밤 11시 전에 주문하세요(마감은 후기 기준). 놓치면 하루 늦게 오니 처방일을 Day3로 옮기세요.",
      action: "호텔 프런트에서 아이스박스 수령 · 아이스팩·봉인 확인",
      payment: "앱에서 알리페이·위챗페이 선결제(해외 Visa·Master 연결) · 현금 필요 없음",
      prep: [
        "중국 휴대폰 번호가 없으면 타오바오를 고르세요. 징둥은 여권 + 중국 번호로 본인 인증해야 처방이 나옵니다(2026-11-12 보도 후기)",
        "+86 번호가 딸린 eSIM(CUniq·3HK 부가번호)이나 공항 통신사 카운터에서 여권으로 사는 유심을 준비하세요. 인증 문자는 +86 번호로만 오고, 데이터 전용 여행 eSIM(Airalo·Holafly·Nomad 등)으로는 못 받습니다",
        "배송 연락처는 호텔 프런트 번호로 지정하고 프런트에서 받으세요. 가입 인증 문자는 호텔 유선번호로 받을 수 없습니다",
        "징둥 대약방(京东大药房)·징둥건강(京东健康) 직영 약국에서만 사세요. 직영만 순펑(顺丰) 콜드체인 직송에 대면 개봉이고, 개인 상점·구매대행은 일반 택배에 아이스팩만 넣어 보냅니다",
        "처방일은 여유 있게 잡으세요. 당일 도착 여부는 창고 재고와 지역에 따라 다르고, 놓치면 하루 늦게 옵니다",
        ...CN_ONLINE_PREP,
      ],
      link: { label: "징둥 · 징둥건강(京东健康) 검색", href: "https://www.jd.com/" },
      sourceRef: SRC.cnOnlineKr,
      sourceRef2: SRC.cnColdChain,
    },
  ];



  // ---------- Global options ----------
  // 통화마다 환율 카드와 '준비할 현금' 안내가 따로 있음. prefix/suffix 는 금액 표기 (324위안)
  const currencies = {
    CNY: {
      code: "CNY",
      name: "위안화",
      prefix: "",
      suffix: "위안",
      fxOptions: [
        { id: "cny_200", title: "1위안 = 200원", subtitle: "기준 · ECB 11/12", krwPerUnit: 200, sourceRef: SRC.fxCny },
        { id: "cny_206", title: "1위안 = 206원", subtitle: "알리페이 해외 카드 수수료 3% 포함 · 보수적", krwPerUnit: 206, sourceRef: SRC.fxCny },
        { id: "cny_195", title: "1위안 = 195원", subtitle: "위안 약세 가정", krwPerUnit: 195, sourceRef: SRC.fxCny },
      ],
      cashStep: 100,
      cashBuffer: range(150, 300),
      cashBufferLabel: "비상 현금",
      cashBufferNote: "알리페이가 안 될 때 택시·노점·보증금",
      cashRxNote: "병원 창구가 해외 카드·알리페이를 못 받을 때 대비 약값·접수비 전액",
      cashNote:
        "병원 수납·노점·택시처럼 알리페이·해외 카드가 막히는 곳에 대비한 현금입니다. 총액에 이미 들어 있는 돈이라 추가 비용은 아닙니다. 병원 카드를 고르면 약값도 여기에 들어갑니다. 위안화는 공항 환전소나 은행 ATM(유니온페이·Visa)에서 구할 수 있습니다.",
    },
  };

  // 11/28(토) 출발 기준. 귀국편 9C7049는 매일 08:00 푸둥 출발이라 마지막 날은 오전 일정이 없음
  const durations = [
    { id: "n2", title: "2박 3일", subtitle: "11/28(토)–11/30(월) · 월요일 연차 1일", nights: 2 },
    { id: "n3", title: "3박 4일", subtitle: "11/28(토)–12/1(화) · 현재 계획 · 월 연차 + 화 오전 반차", nights: 3 },
    { id: "n4", title: "4박 5일", subtitle: "11/28(토)–12/2(수) · 근교 당일치기까지 여유", nights: 4 },
  ];

  // 출발 방식: 청주→푸둥은 춘추항공 낮 편뿐. startOffset 은 시기 카드의 출발일(토) 기준 차이
  const departures = [
    {
      id: "sat_noon",
      title: "토 낮 출발 (청주 12:05)",
      subtitle: "가는 편 9C7050 청주 12:05 → 푸둥 13:10 · 오는 편 9C7049 푸둥 08:00 → 청주 11:05",
      startOffset: 0,
      arrival: "afternoon",
      workFirstDay: false,
      flightFactor: 1.0,
      lastEvening: "밤 짐 정리 · 디디 05:00 예약 · 프런트에 조식 도시락(早餐打包) 부탁 · 펜은 냉장고에 두었다가 아침에 보냉 파우치로",
      sourceRef: sourceRef(
        "굿모닝충청 - 춘추항공 청주-상하이 정기노선 취항(2026-04)",
        "https://www.goodmorningcc.com/news/articleView.html?idxno=445170",
        "취항 당시 시간표: 9C7050 월·금·토 12:05 → 13:10, 일 11:50, 화·목 22:00 출발. 귀국 9C7049 08:00 → 11:05(약 2시간). 6/3부터 매일 운항. 동계(10/25-) 시간표는 공식 발표를 찾지 못했고, 10/23 실제 운항은 12:29 출발 기록입니다. 예약할 때 시각을 다시 확인하세요."
      ),
    },
  ];

  const seasons = [
    {
      id: "w1128",
      title: "11/28(토) 출발",
      startDate: "2026-11-28",
      flightFactor: 1.0,
      parkTier: "base",
      subtitle: "출발 10일 전 · 상하이 낮 10-15℃, 아침 5℃ 안팎",
      notes: [
        "가격: 출발까지 열흘이라 항공·호텔은 지금 가격이 거의 최종가입니다. 카드의 금액은 추정이니, 이 탭 위의 링크에서 실제 가격을 확인해 확정가로 넣으세요.",
        "날씨: 11월 말 상하이는 낮 10-15℃, 아침 5℃ 안팎입니다(평년 기준 추정). 털게(大闸蟹)는 제철 끝물입니다.",
        "비자: 한국 일반여권은 30일 무비자(2026-12-31까지)라 비자가 필요 없습니다.",
      ],
      sourceRef: sourceRef("추정 (출발 10일 전 · 중국 노선 11월 말 비수기)", "https://www.google.com/travel/flights?hl=ko", "11월 말은 중국 노선 비수기라 배율 1.0으로 둡니다. 출발이 가까워 오르는 몫은 항공 카드 범위에 넣었습니다."),
    },
  ];

  // ---------- Mounjaro prescription (global) ----------
  // 용량 키: d10 = 40mg 펜(1회 10mg). d25/d5 는 2.5mg·5mg 4주분(병원 고시가). 플랜(countries[].rxPlans)은 용량별 주 수이고,
  // 클리닉의 per4CNY(4주분 가격)를 주 수에 비례해 계산함
  const rx = {
    days: [
      { id: "rx_d1", dayIndex: 0, title: "Day1 도착일", subtitle: "추천 · 금요일 밤 한국에서 주문 → 체크인하며 수령 · 하루 늦어도 Day2에 받음" },
      { id: "rx_d2", dayIndex: 1, title: "Day2", subtitle: "토요일 밤 현지에서 주문 → 일요일 오후 수령 · 병원 대면은 사립만(공립은 일요일 휴진)" },
      { id: "rx_d3", dayIndex: 2, title: "Day3", subtitle: "택배가 하루 늦을 때의 예비일 · 공립병원 대면도 가능" },
    ],
    patients: { min: 1, defaultValue: 1 },
    // 반입: 기본 6병, 6병을 넘으면 용법상 3개월분(12주)까지
    importBaseUnits: 6,
    importLimitWeeks: 12,
    koreaPer4KRW: { d25: range(290000, 350000), d5: range(370000, 450000), d75: range(510000, 600000), d10: range(500000, 600000) },
    // 나라와 무관한 안내. 나라별 안내는 countries[].rxNotes
    notes: [
      "반입 한도: 해외에서 정상 처방·구매한 마운자로는 본인이 직접 들고 오면 반입할 수 있습니다(11/12 시행). 1인 기본 6병이고, 6병을 넘으면 3개월분(12주분)까지입니다. 직구·우편·대리구매는 여전히 안 됩니다.",
      "증빙: 귀국 때 영수증·처방 내역·원래 상자를 챙기세요. 영문 처방증명서도 받을 수 있으면 받아 두세요.",
      "보관: 펜은 기내에 들고 타세요(화물칸은 얼 수 있음). 냉장이 원칙이지만 30℃ 이하 실온에서 누적 21일까지는 괜찮습니다.",
      "호텔: 택배는 첫날부터 묵는 4성급 호텔로 받습니다. 예약할 때 객실 냉장고(미니바 포함)가 있는지, 프런트가 냉장 택배를 받아 냉장 보관해 주는지 확인하세요.",
      "유의: 반입한 약은 국내 부작용 피해구제 대상이 아닙니다. 용량·수량은 진찰 후 의사가 정하므로 원하는 만큼 나온다는 보장이 없습니다.",
      "첫 주사: 처음 맞으면 1-3일은 메스꺼움·식욕 저하가 흔합니다. 이색 식사·특식은 첫 주사 전에 몰아 두세요. 첫 주사를 귀국 후로 미루면 여행이 편합니다.",
    ],
    sourceRefs: [SRC.rxImport2, SRC.rxImportScope, SRC.rxSafety, SRC.rxPriceKr, SRC.rxPriceKr75, SRC.rxPriceTen, SRC.rxStorage, SRC.cnPhoneSim],
  };

  const party = {
    travelers: { min: 1, max: 8, defaultValue: 2 },
    note: "성인 기준 · 항공·입장권·교통 모두 성인 요금",
  };

  // occupancy: 1실 인원, priceFactor: 트윈 1실 요금 대비 배율, perPersonFactor: 료칸(1인 요금) 1실 인원별 배율
  const roomConfigs = [
    {
      id: "occ1",
      title: "1인 1실",
      occupancy: 1,
      perPersonFactor: 1.4,
      priceFactor: 0.95,
      subtitle: "각자 방 · 더블룸(大床房) 1인 사용 · 트윈가 ×0.95 가정",
      sourceRef: sourceRef("추정 (중국 호텔 더블·트윈 요금)", "https://www.booking.com/city/cn/shanghai.html", "중국 호텔은 객실 단위 요금이라 1인 할인이 거의 없습니다. 더블룸(大床房)은 트윈룸(双床房)과 같거나 조금 쌉니다."),
    },
    {
      id: "occ2",
      title: "2인 1실 (트윈)",
      occupancy: 2,
      priceFactor: 1.0,
      perPersonFactor: 1.0,
      sourceRef: sourceRef("추정 (중국 호텔 트윈 기준)", "https://www.booking.com/city/cn/shanghai.html", "호텔 카드 가격은 트윈룸(双床房, 침대 2개) 1실 기준입니다. 더블룸(大床房)은 침대가 1개라 제외합니다."),
      subtitle: "트윈룸(双床房, 침대 2개)만 · 트윈이 없으면 1인 1실 2개",
    },
    {
      id: "occ3",
      title: "3인 1실",
      subtitle: "트리플 · 침대 3개 · 트윈가 ×1.4 가정",
      occupancy: 3,
      priceFactor: 1.4,
      perPersonFactor: 0.95,
      sourceRef: sourceRef("추정 (중국 트리플 ≈ 트윈 1.3-1.5배)", "https://www.booking.com/city/cn/shanghai.html", "트리플룸(三人间)이 있는지는 호텔마다 다릅니다."),
    },
    {
      id: "occ4",
      title: "4인 1실",
      subtitle: "쿼드 · 침대 4개 · 트윈가 ×1.7 가정",
      occupancy: 4,
      priceFactor: 1.7,
      perPersonFactor: 0.9,
      sourceRef: sourceRef("추정 (중국 쿼드룸 ≈ 트윈 1.5-1.8배)", "https://www.booking.com/city/cn/shanghai.html", "쿼드룸(四人间)이 있는지는 호텔마다 다릅니다."),
    },
  ];

  const mealLevels = [
    {
      id: "budget",
      title: "가성비",
      perPersonPerDayCNY: range(70, 120),
      sourceRef: sourceRef("Numbeo - 상하이 생활비(Shanghai cost of living)", "https://www.numbeo.com/cost-of-living/in/Shanghai", "저가 식당 1끼 20위안 안팎을 기준으로 합니다."),
      subtitle: "면·만두·덮밥·편의점 조식",
    },
    {
      id: "mixed",
      title: "혼합",
      perPersonPerDayCNY: range(140, 230),
      sourceRef: sourceRef("Numbeo - 상하이 생활비(Shanghai cost of living)", "https://www.numbeo.com/cost-of-living/in/Shanghai", "중급 식당과 카페를 섞는다고 가정합니다."),
      subtitle: "로컬 식당·훠궈·카페 섞기",
    },
    {
      id: "gourmet",
      title: "맛집 위주",
      perPersonPerDayCNY: range(300, 500),
      subtitle: "해산물·카오야(烤鸭)·유명 식당 · 주류 포함",
      sourceRef: sourceRef("추정 (중국 대도시 1인 하루 식비)", "https://www.numbeo.com/cost-of-living/country_result.jsp?country=China", "Numbeo 중국 평균은 저가 식당 1끼 20위안(13-40), 중급 식당 2인 150위안(100-300)입니다. 여행자 동선 기준으로 3단계를 추정하고 도시별 배율(mealFactor)을 곱합니다."),
    },
  ];


  // 중국은 크리스마스가 평일이고 연말 연휴는 위안단(1/1-1/3)뿐
  const lodgingCalendarCn = {
    weekday: [1.0, 1.0, 1.0, 1.0, 1.0, 1.15, 1.25], // 일 월 화 수 목 금 토
    dates: {
      "2026-12-24": 1.15, // 목 · 크리스마스 이브 (도심 호텔만 소폭)
      "2026-12-31": 1.4, // 목 · 위안단 전야
      "2027-01-01": 1.4,
      "2027-01-02": 1.3,
    },
    sourceRef: sourceRef(
      "추정 (중국 숙박 요일·연말 요금 패턴)",
      "https://www.booking.com/city/cn/shanghai.html",
      "평일 1.0, 금 ×1.15, 토 ×1.25, 위안단(元旦) 연휴(12/31-1/2) ×1.3-1.4로 추정합니다. 12월은 비수기라 주말 상승폭을 일본보다 작게 잡았습니다."
    ),
  };

  // ---------- Countries ----------
  // weeksPerPen: 펜 1개에 든 주 수. doseLabel: 그 나라에서 펜을 부르는 이름(중국은 펜 총량).
  // rxPlans: 고를 수 있는 용량·주 수. rxNotes: 메모 탭 맨 위에 붙는 나라별 처방·결제 안내
  const countries = {
    cn: {
      id: "cn",
      name: "중국",
      currency: "CNY",
      routeNote: "온라인 주문 뒤 호텔 수령 · 병원 대면 · 12/31까지 무비자",
      weeksPerPen: 4,
      penNote: "펜 1개 = 4회(4주)분 · 펜 이름은 총량이라 40mg 펜이 1회 10mg",
      doseLabel: { d25: "10mg", d5: "20mg", d10: "40mg" },
      rxPlans: [
        { id: "p10x24", subtitle: "24주분 · 매주 10mg · 반입 기본 한도(6병) 안", weeks: { d10: 24 } },
        { id: "p10x12", subtitle: "12주분 · 매주 10mg · 3개월분 기준 안", weeks: { d10: 12 } },
      ],
      defaultRxPlanId: "p10x24",
      importLimitNote: "기본 6병 기준",
      lodgingCalendar: lodgingCalendarCn,
      luggageRxDay: "짐은 새 숙소 프런트에 맡기기",
      luggageLastDay: "짐은 호텔 프런트에",
      twinNote: "2인 1실은 트윈룸(双床房, 침대 2개)으로 계산합니다. 예약할 때 객실 유형이 '双床房'인지 확인하세요. 더블룸(大床房)은 침대가 1개입니다.",
      singleNote: "1인 1실은 트윈 요금의 95%로 계산합니다. 중국 호텔은 객실 단위 요금이라 혼자 써도 거의 같은 값입니다.",
      rxNotes: [
        "펜: 중국 마운자로 무펑다(穆峰达)는 4회용 펜이고, 이름이 총량입니다(40mg 펜 = 1회 10mg × 4주). 첫 주사 뒤에도 냉장 보관하세요.",
        "6펜 반입: '기본 6병' 안이지만 24주분입니다. 3개월분 기준 적용 여부는 공식 설명이 없으니 출국 전 관세청(125)에 확인하고, 불안하면 3펜으로 줄이세요.",
        "약값: 공립병원은 전국 고시가입니다(4주분, 1회 2.5mg 324위안 · 5mg 551위안 · 10mg 937위안). 온라인몰 40mg 펜은 1,030-1,500위안대입니다. 감량 목적은 전액 자비입니다.",
        "처방 기준: BMI 28 이상, 또는 24 이상 + 체중 관련 질환입니다. 혈액검사 뒤 의사가 판단하며, 해당하지 않으면 처방이 나오지 않습니다.",
        "5/15 새 규정: 약국은 병원 종이 처방전(발급 3일 이내)을 요구하고, 감량 목적 온라인 판매는 금지됐습니다. 증빙은 병원 진료 후 원내 약국 구매가 가장 확실합니다.",
        "결제 준비: 출국 전에 끝내세요. 알리페이·위챗페이 설치 → 여권 인증 → 해외 카드 등록 → 소액 결제 1회 테스트 순서입니다. 가장 자주 막히는 단계는 카드 등록 문자 인증입니다(한국 번호 로밍 필요). 애플페이·구글페이는 해외 카드로 대체로 안 됩니다.",
        "수수료 · 한도: 해외 카드 결제는 200위안을 넘으면 수수료 3%입니다(위챗페이는 2026-12-31까지 첫 등록 후 90일간 하루 1,000위안까지 면제). 한도는 건당 5,000달러·연 50,000달러(규제 상한)이고, 위챗페이는 건당 6,500위안·월 5만위안·연 6.5만위안으로 더 낮습니다.",
        "카드 · 현금: 실물 카드는 호텔·공항·백화점·체인·일부 택시에서만 됩니다(해외 발급 유니온페이는 본토 POS 대부분 가능). 현금 300~1,000위안은 늘 지니세요(병원 수납·노점·개인 QR·택시). ATM 인출은 건당 3,000위안까지이고, 환전은 공항·중국은행(中国银行)에서 합니다.",
      ],
      sourceRefs: [SRC.cnPrice, SRC.cnIndication, SRC.cnRule, SRC.cnOnline, SRC.cnOnlineKr, SRC.cnColdChain, SRC.cnVisa, SRC.cnAlipay, SRC.cnPhoneSim, SRC.cnPayLimit, SRC.cnPayGuide, SRC.cnPayTest, SRC.cnPayWechat],
    },
  };

  const calculationRules = {
    contingencyRate: 0.1, // 예상 합계의 10%를 고정액으로 (범위를 넓히지 않음)
    bandZ: 1.2816, // 각 항목 [min, max] = P10-P90 로 보고, 합계도 P10-P90 로 표시
    mealDays: "nightsPlusOne",
    ryokanMealCredit: 0.6, // 1박2식 료칸: 그날 식비의 60%(석식+조식) 차감
    sourceRef: sourceRef(
      "계산 방식 - 독립 항목의 불확실성 합산",
      "https://en.wikipedia.org/wiki/Propagation_of_uncertainty",
      "항목별 범위를 P10-P90으로 보고 표준편차 = 폭/(2×1.28)로 계산합니다. 합계 표준편차 = √(Σ항목 분산)입니다. 항공·숙박·식비가 한꺼번에 최고가가 될 가능성은 낮다고 보므로 단순 합산보다 좁습니다. 확정가를 넣은 항목은 분산 0입니다."
    ),
  };

  // ---------- Cities ----------
  const cities = {
    shanghai: {
      id: "shanghai",
      country: "cn",
      name: "상하이",
      subtitle: "청주 출발 · 4성급 호텔로 냉장 택배 수령 · 샤오룽바오·와이탄",
      flightTime: "약 2시간 10분",
      mealFactor: 1.3,
      bookingCity: "Shanghai",
      airportTitle: "푸둥공항 ↔ 시내",
      departureLunchOk: false,
      // 카드 묶음 제목. 클리닉은 수령 방식(mode)으로, 관광은 하루 중 차지하는 시간(slot)으로 나눔
      clinicGroups: [
        { label: "온라인 주문 → 호텔에서 수령 · 2형 당뇨·고혈당 진단이 있어야 함", modes: ["delivery"] },
        { label: "병원 대면 진료 · 감량 목적 처방은 미확인 · 보통 4주분(1펜)만", modes: ["visit"] },
      ],
      activityGroups: [
        { label: "종일 코스", slots: ["full"] },
        { label: "반나절 코스", slots: ["half"] },
        { label: "아침 · 점심", slots: ["morning", "lunch"] },
        { label: "저녁 · 야경", slots: ["evening"] },
      ],
      // 비어 있는 날의 큰 코스(앞에서부터 빈 날에 차례로). 3박 기본은 Day2(일) · Day3(월)이 받음.
      // Day2 는 예원·임시정부청사(월 휴관)가 반나절 둘을 차지하므로 가벼운 아침 코스, Day3(월)은 휴관 없는 거리 위주
      freeDays: ["아침 와이탄 산책 · 와이바이두차오(外白渡桥) · 쑤저우허 산책로 — 호텔 근처, 사람 적은 시간", "우캉루(武康路) · 안푸루(安福路) · 콜롬비아 서클(上生新所) — 옛 프랑스 조계 골목, 월요일도 OK", "난징시루 스타벅스 리저브 로스터리 · 장위안(张园) 스쿠먼 골목 · 징안쓰(静安寺)", "M50 창의원 · 톈안첸수(天安千树) — 장닝루역", "웨스트번드(西岸) 강변 · 미술관 거리 (월요일 휴관 많음)"],
      notes: [
        "병원 대면: 온라인 주문이 막힐 때의 대안입니다. 상하이에서 관광객에게 감량 목적으로 마운자로(穆峰达)를 처방한다고 공식 안내하는 병원은 찾지 못했습니다(11/13 기준). 목록의 병원은 여권으로 접수할 수 있고 주말 외래와 내분비·체중관리 진료가 있는 곳입니다. 예약할 때 ① 여권 초진 ② 감량 목적 처방 ③ 원내 약국 재고 ④ 한 번에 받는 펜 수를 꼭 확인하세요.",
        "병원 요일: 공립병원 국제의료부는 월-토 외래이고 일요일은 쉽니다. 사립 국제병원은 일요일에도 외래를 봅니다. 토요일 오후에 도착하므로 일요일(Day2)은 사립만, 월요일(Day3)은 공립까지 됩니다.",
        "택배 수령: 받는 사람은 예약자와 같은 여권 영문 이름, 주소는 호텔 중국어 주소 뒤에 '前台代收'(프런트 대리 수령), 전화는 로밍한 한국 번호(+82)나 호텔 대표번호로 적습니다. 4성급 국제 체인은 프런트·컨시어지가 24시간 있어 투숙 예정 손님 택배를 맡아 주는 것이 보통이지만, 약품 냉장 보관까지 되는지는 답장으로 꼭 확인하세요.",
        "호텔에 보낼 메시지: 금요일 밤 한국에서 주문하면 체크인 전에 도착할 수 있으니, 예약 확정 뒤 미리 부탁하세요. '我是11月28日入住的客人○○○，入住前会有一个冷藏快递送到，麻烦帮忙代收并放冰箱保管，谢谢' (11월 28일 체크인 예정인 ○○○입니다. 체크인 전에 냉장 택배가 도착하면 대신 받아 냉장고에 보관해 주세요)",
        "결제: 알리페이·위챗페이에 해외 카드를 연결해 두세요. 200위안이 넘는 결제에는 수수료 3%가 붙습니다. 지하철은 해외 비접촉 카드를 개찰구에 바로 찍으면 됩니다. 노점과 개인 QR은 해외 카드가 안 되는 곳이 있으니 현금을 조금 챙기세요.",
        "동선: 황푸강 서쪽 푸시(와이탄·난징둥루·예원·신톈디·우캉루)와 동쪽 푸둥(루자쭈이·동방명주·상하이 타워)으로 나눠 짜세요. 낮에는 골목·정원, 해 진 뒤에는 난징둥루 → 와이탄 순서가 편합니다. 지하철역에 에스컬레이터가 많아 이동이 쉽습니다. 디즈니는 하루를 통째로 쓰니 3박이면 빼는 편이 낫습니다.",
        "화장실 · 식당: 화장실에 휴지가 없는 곳이 많으니 휴대용 티슈를 늘 챙기세요. 식당은 테이블 QR로 주문하고 알리페이로 결제하는 곳이 많고, 인기 식당 대기는 다중뎬핑이나 위챗으로 겁니다.",
        "보조배터리: 3C 마크 규정은 중국 국내선에만 적용됩니다. 상하이-청주 국제선은 용량(100Wh 이하) 표기가 보이면 되지만, 표기가 지워진 제품은 보안검색에서 뺏길 수 있습니다.",
        "택시: 알리페이 안의 디디(滴滴)로 부르세요. 목적지는 한자 이름으로 검색하는 것이 정확합니다.",
        "귀국일 새벽: 9C7049는 푸둥 08:00 출발입니다. 국제선 체크인 마감(보통 출발 60분 전)과 출국 심사를 생각하면 06:00 전후에 공항에 있어야 하니, 시내에서 05:00-05:15에 디디·택시로 떠나세요(05시 이후면 심야 할증 없음). 지하철 2호선·자기부상 첫차로는 늦습니다. 전날 밤 프런트에 택시와 조식 도시락(早餐打包)을 부탁해 두면 편합니다.",
        "청주공항: 12:05 출발이라 10시 전후에 주차장에 들어가세요. 펜은 기내에 들고 타고, 젤 아이스팩은 보안검색에서 액체로 볼 수 있으니 보냉 파우치와 처방 영수증을 함께 챙기세요. 춘추항공은 기본 운임에 위탁 수하물이 없는 경우가 많으니 예약할 때 확인하세요.",
      ],
      // 출발 전 준비. daysBefore 는 출발일(Day1) 기준. 처방 예약 단계와 함께 날짜순으로 일정 탭 '출발 전'에 들어감
      preTrip: [
        { daysBefore: 7, text: "알리페이·위챗 설치 → 여권 실명 인증 → 해외 카드 등록 → 소액 결제 테스트 (카드 등록 문자 인증이 가장 자주 막힘 · 한국 번호 로밍 필요)" },
        { daysBefore: 5, text: "가오더 지도(高德地图)·다중뎬핑(大众点评)·메이퇀(美团) 설치 · 가고 싶은 곳을 한자 이름으로 가오더 지도에 저장하고 메모에 한국어 이름 적기" },
        { daysBefore: 4, text: "로밍형 eSIM 구매·설치 (상품 설명에서 'VPN 없이 유튜브·카카오톡 가능' 확인 · 하루 1-3GB · 설치는 한국에서, 개통은 도착 후) — 통신사 로밍을 쓸 거면 출발 전날 신청" },
        { daysBefore: 3, text: "중국 전자 입국신고서 작성 (도착 72시간 전부터 · NIA 12367 앱이나 위챗·알리페이 미니프로그램 · 공항 키오스크·종이 카드도 가능)" },
        { daysBefore: 2, text: "호텔에 메시지 보내기(Booking·Trip.com 채팅이나 이메일): 체크인 전 냉장 택배 대리 수령·냉장 보관 부탁 → 답장 확인 · 호텔 중국어 주소·전화번호 복사해 두기 (중국어 문구는 '예약 · 메모' 탭 메모에)" },
        { daysBefore: 2, text: "여행자보험 가입 · 춘추항공 온라인 체크인과 위탁 수하물 추가 · 대한민국 임시정부청사 재개관·운영시간 확인" },
        { daysBefore: 1, text: "짐 싸기: 보조배터리는 기내에 (용량 표기 또렷한 100Wh 이하, 1인 2개, 기내 사용 금지) · 휴대용 티슈·물티슈 · 멀티 어댑터 · 접이식 우산 · 보냉 파우치" },
        { daysBefore: 0, text: "10시 전후 청주공항 주차 → 12:05 9C7050 탑승 (수속은 출발 2시간 전부터)" },
      ],
      clinics: [
        ...cnOnlineClinics(),
        {
          id: "jiahui",
          title: "자후이(嘉会) 국제병원 · 징안 클리닉",
          subtitle: "사립 · 매일 9-18시 · 영어(한국어 일부) · 진찰료 500-1,500위안",
          short: "자후이",
          mode: "visit",
          openDays: [0, 1, 2, 3, 4, 5, 6],
          irregular: true,
          usualMaxWeeks: 4,
          hours: "징안 클리닉 매일 9:00-18:00 · 본원 예약제 · 체중관리·내분비 의사 출진일 확인",
          per4CNY: { d25: range(324, 600), d5: range(551, 900), d10: range(937, 1500) },
          estimatedDoses: ["d10"],
          feeCNY: range(1000, 3200),
          action: "자후이 가정의학과 체중관리 진료 · 원내 약국 수령 · 징안 창수루 88호(常熟路88号) · 본원 구이핑루 689호(桂平路689号)",
          payment: "전액 자비입니다. 창구에서 해외 Visa·Master를 받는지는 공식 페이지에서 확인하지 못했습니다. 알리페이(해외 카드 연결)와 현금을 함께 준비하세요.",
          prep: [
            "400-868-3000(24시간), WhatsApp +852 4619 1904, internationaloffice@jiahui.com으로 영어로 문의하세요. 여권 초진, 감량 목적 마운자로(穆峰达)·성분명 터제파타이드(替尔泊肽) 처방, 원내 약국 재고·가격, 한 번에 받는 펜 수를 확인합니다.",
            "공식 페이지에서 확인한 내용입니다. 가정의학과 특수클리닉에 체중관리(Weight Management) 클리닉이 있고, 한국어가 되는 가정의가 1명 있으며, 본원 서비스 언어에 한국어가 있습니다. 터제파타이드 취급 여부는 어디에도 없습니다.",
            "공식 요금표(2024-01) 기준 진찰료 500-1,500위안, 혈구검사 100위안, 공복혈당 60위안입니다. 간·신장·갑상선·췌장 수치까지 보면 검사비는 수백-2,000위안으로 추정합니다.",
            "첫 처방은 보통 4주분(1펜)입니다. 12주분(3펜)을 원하면 한국 처방 이력과 현재 용량 증빙을 가져가 요청하세요. 거절될 수 있습니다.",
            "원내에 약이 없으면 종이 처방전(발급 3일 이내)으로 시내 약국에서 삽니다. 처방전 사본과 영수증(发票)을 챙기세요.",
          ],
          link: { label: "자후이 가정의학과 체중관리 클리닉 · 온라인 예약", href: "https://jiahui.com/en/service/3" },
          sourceRef: sourceRef("자후이 헬스(Jiahui Health) - 가정의학과·요금표(Family Medicine / Fee schedule)", "https://jiahui.com/en/service/3", "가정의학과 특수클리닉에 체중관리(Weight Management)가 있습니다. 의사 다수가 영어를, 1명(XU Huijing)이 한국어를 합니다. 예약은 온라인·앱·400-868-3000으로 합니다. 요금표(jiahui.com/en/pricing, 2024-01-15)는 외래 진찰 500-1,500위안, 혈구검사(CBC) 100위안, 공복혈당 60위안입니다. GLP-1·터제파타이드 언급이 없어 약값은 고시가와 온라인몰 정가 사이로 추정합니다."),
          sourceRef2: sourceRef("상하이시 외국인 의료 안내 - 자후이 헬스 자징 클리닉(Jiahui Health Jiajing Clinic)", "https://english.shanghai.gov.cn/en-FindaHospital/20241011/a204d34c3d9343948b1bf715c3960e32.html", "징안구 창수루 88호(静安区常熟路88号), 월-일 9:00-18:00, 021-2285-2800, 서비스 언어 영어, 가정의학과. 본원은 쉬후이구 구이핑루 689호(徐汇区桂平路689号)이며, 같은 사이트에 24시간·한국어 포함으로 기재돼 있습니다."),
        },
        {
          id: "sinounited",
          title: "야오잉(曜影) 병원 · 체중·대사 관리센터",
          subtitle: "사립 · 매일 8-18시 · 영어 · 와이탄 옆 · 요금 미공개",
          short: "야오잉",
          mode: "visit",
          openDays: [0, 1, 2, 3, 4, 5, 6],
          irregular: true,
          usualMaxWeeks: 4,
          hours: "외래 매일 8:00-18:00 · 내분비·체중대사 의사 출진일 확인",
          per4CNY: { d25: range(324, 600), d5: range(551, 900), d10: range(937, 1500) },
          estimatedDoses: ["d10"],
          feeCNY: range(1000, 3200),
          action: "야오잉 병원 내분비·체중대사 진료 · 원내 약국 수령 · 장시중루 350호(江西中路350号), 난징둥루역 부근",
          payment: "전액 자비입니다. 결제 수단은 공식 확인이 안 됐습니다. 해외 카드, 알리페이(해외 카드 연결), 현금을 모두 준비하세요.",
          prep: [
            "400-186-2116이나 internationalcare@suh.cn으로 영어로 문의하세요. 여권 초진, 감량 목적 마운자로(穆峰达) 처방 여부, 재고·가격, 한 번에 받는 펜 수를 확인합니다.",
            "2025-05에 문을 연 체중·대사 관리센터는 제10인민병원 비만센터장 취선(曲伸) 교수가 이끕니다. 약물치료를 한다고만 밝혔고 약 이름과 가격은 공개하지 않았습니다.",
            "진찰료와 검사비는 공개되지 않았습니다. 자후이 요금표 수준(진찰 500-1,500위안 + 혈액검사)으로 추정합니다.",
            "서비스 언어는 중국어와 영어이고 한국어는 없습니다. 첫 처방은 보통 4주분(1펜)입니다.",
          ],
          link: { label: "상하이시 외국인 의료 안내 · 야오잉 병원", href: "https://english.shanghai.gov.cn/en-FindaHospital/20260807/e0db8c76aced4bb08df244b3d2f54479.html" },
          sourceRef: sourceRef("상하이시 외국인 의료 안내 - 상하이 야오잉 병원(Shanghai SinoUnited Hospital)", "https://english.shanghai.gov.cn/en-FindaHospital/20260807/e0db8c76aced4bb08df244b3d2f54479.html", "황푸구 장시중루 350호(黄浦区江西中路350号), 외래 월-일 8:00-18:00, 400-186-2116, internationalcare@suh.cn, 언어 중국어·영어. 진료과에 내분비·대사과(Endocrinology and Metabolism)가 있습니다. 요금과 결제 수단은 기재되지 않아 추정합니다."),
          sourceRef2: sourceRef("스마트상하이(SmartShanghai) - 야오잉 체중·대사 관리센터(SinoUnited Health Weight and Metabolism Management Center)", "https://www.smartshanghai.com/articles/community/hollywood-executive-loses-82-pounds-sinounited-health-weight-and-metabolism-management-center-officially-opens", "2025-05-12 개설, 취선(曲伸) 교수 주도. 내분비·영양·중의·심리를 원스톱으로 보고 영양·약물·수술 치료를 합니다. 약 이름과 가격은 없습니다(홍보성 기사)."),
        },
        {
          id: "ruijin_intl",
          title: "루이진 병원(瑞金医院) 국제의료부",
          subtitle: "공립 · 월-토 8-17시 · 영어 · 내분비 명문 · 약값은 전국 고시가",
          short: "루이진 국제부",
          mode: "visit",
          openDays: [1, 2, 3, 4, 5, 6],
          irregular: true,
          usualMaxWeeks: 4,
          hours: "월-토 8:00-17:00 · 토요일 내분비 출진은 예약 때 확인",
          per4CNY: { d25: range(324, 330), d5: range(551, 560), d10: range(937, 950) },
          estimatedDoses: ["d10"],
          feeCNY: range(600, 2000),
          action: "루이진 병원 국제의료부 내분비 진료 · 원내 약국 수령 · 루이진얼루 197호(瑞金二路197号) 10호동, 9호선 다푸차오역",
          payment: "국제의료부 창구에서 자비로 결제합니다. 해외 카드 사용 가능 여부는 공식 확인이 안 됐습니다. 알리페이(해외 카드 연결)와 현금을 준비하세요.",
          prep: [
            "021-6467-8970(월-토 8:00-11:30 · 13:30-16:30)이나 vip@rjh.com.cn으로 예약하세요. 여권 초진, 내분비과의 감량 목적 마운자로(穆峰达) 처방, 토요일 출진, 원내 약국 재고를 확인합니다.",
            "진찰료는 공식 자료에 없습니다. 여행 가이드 기준 국제·특수 외래 300-1,500위안에 혈액검사(혈당·간·신장·지질·갑상선) 수백 위안을 더해 추정했습니다.",
            "중국 허가 기준(BMI 28 이상, 또는 24 이상 + 동반질환)에 못 미치면 처방이 안 나올 수 있습니다. 한국 처방 이력과 현재 용량 증빙을 가져가세요.",
            "공립병원은 외국인 환자에게 장기 처방을 잘 내지 않습니다. 만성질환도 14일마다 재처방한 사례가 있습니다. 4주분(1펜)을 기준으로 잡으세요.",
            "대안은 중산병원(中山医院) 국제의료부입니다. 이쉐위안루 111호(医学院路111号), 토요일 8-12시, 400-626-0121.",
          ],
          link: { label: "상하이시 외국인 의료 안내 · 루이진 병원 국제의료부", href: "https://english.shanghai.gov.cn/en-FindaHospital/20241014/c1033495f786489db7adbad3a62c3ecf.html" },
          sourceRef: sourceRef("상하이시 외국인 의료 안내 - 루이진 병원(Ruijin Hospital)", "https://english.shanghai.gov.cn/en-FindaHospital/20241014/c1033495f786489db7adbad3a62c3ecf.html", "황푸구 루이진얼루 197호(黄浦区瑞金二路197号), 외래 10호동 B1·1층, 월-토 8:00-17:00, 021-6467-8970, vip@rjh.com.cn, 서비스 언어 영어. 진료과에 내분비과(Endocrinology)가 있습니다. 감량 약 처방과 진찰료는 기재되지 않았습니다. 약값은 공립병원 전국 고시가(2.5mg 324.1위안 · 5mg 551위안)로 가정합니다."),
          sourceRef2: sourceRef("란징 뉴스(蓝鲸新闻) - 상하이 외국인 진료 불편(시 정협위원 인터뷰, 2026-02)", "https://www.lanjinger.com/d/1770089730744154572", "2급 이상 병원의 약 70%가 외국인이 흔히 쓰는 결제 수단을 지원하지 않습니다. 영어로 기본 진료 소통이 되는 외국인은 41%입니다. 고혈압·당뇨 외국인 환자는 장기처방을 받지 못해 14일마다 다시 접수하고 처방받습니다. 처방 기간과 결제 주의의 근거입니다."),
        },
        {
          id: "tenth_intl",
          title: "상하이 제10인민병원(上海市第十人民医院) 국제의료부",
          subtitle: "공립 · 월-토 8-17시 · 영어·일본어 · 비만 관리 특화 진료",
          short: "제10인민병원 국제부",
          mode: "visit",
          openDays: [1, 2, 3, 4, 5, 6],
          irregular: true,
          usualMaxWeeks: 4,
          hours: "월-토 8:00-17:00 · 전화 문의 월-금 8-17시",
          per4CNY: { d25: range(324, 330), d5: range(551, 560), d10: range(937, 950) },
          estimatedDoses: ["d10"],
          feeCNY: range(600, 2000),
          action: "제10인민병원 국제의료부 비만·내분비 진료 · 원내 약국 수령 · 옌창중루 301호(延长中路301号), 1호선 옌창루역 부근(추정)",
          payment: "국제의료부 창구에서 자비로 결제합니다. 해외 카드 사용 가능 여부는 공식 확인이 안 됐습니다. 알리페이(해외 카드 연결)와 현금을 준비하세요.",
          prep: [
            "021-6630-7026, 021-6630-1159(평일)로 예약하세요. 여권 초진, 토요일 비만·내분비 출진, 감량 목적 마운자로(穆峰达) 처방과 재고를 확인합니다.",
            "상하이시 공식 안내는 국제의료부 특화 진료로 비만 관리(Obesity Management)를 명시합니다. 루이진·중산 안내에는 없는 항목입니다. 관광객 처방 사례는 확인하지 못했습니다.",
            "비만증 진료센터 본진은 추장루(虬江路) 원구에 있습니다. 국제의료부(옌창중루)에서 같은 진료와 처방이 되는지 물어보세요.",
            "진찰료는 공식 자료에 없어 루이진과 같은 수준으로 추정합니다. 원인 선별검사 뒤 처방하는 것이 기본이고, 첫 처방은 4주분(1펜) 기준입니다.",
          ],
          link: { label: "상하이시 외국인 의료 안내 · 상하이 제10인민병원", href: "https://english.shanghai.gov.cn/en-FindaHospital/20241012/e58ca59b68794f9cad00e39fdd77b26c.html" },
          sourceRef: sourceRef("상하이시 외국인 의료 안내 - 상하이 제10인민병원(Shanghai Tenth People's Hospital)", "https://english.shanghai.gov.cn/en-FindaHospital/20241012/e58ca59b68794f9cad00e39fdd77b26c.html", "징안구 옌창중루 301호(静安区延长中路301号), 월-토 8:00-17:00, 021-6630-7026(월-금), 언어 영어·일본어·프랑스어 등. 특화 진료에 비만 관리(Obesity Management)와 내분비가 있습니다. 진찰료는 기재되지 않아 추정합니다. 약값은 전국 고시가로 가정합니다."),
          sourceRef2: sourceRef("둥팡왕(东方网)·텐센트 뉴스 - 상하이 첫 다학제 감량센터 업그레이드 공개(上海首个多学科减重中心升级亮相)", "https://news.qq.com/rain/a/20260430A08ZFP00", "2026-04 추장루(虬江路) 원구 비만증 진료센터 3.0 공개. 내분비·대사외과 중심 다학제로, 한 번 접수하면 원스톱으로 진료합니다. 원인 7종 선별검사와 GLP-1 계열 약물치료를 하고, 연 외래는 1.5만 명입니다. 운영 시간·요금·국제부 연계는 기재되지 않았습니다."),
        },
      ],
      // 인터넷: 데이터가 중국 밖으로 나가는 방식(로밍·로밍형 eSIM)만 유튜브·네이버·카카오톡이 열림
      dataPlans: [
        {
          id: "esim_roam",
          title: "로밍형 여행 eSIM · 유심",
          subtitle: "유튜브·네이버·카카오톡·구글이 VPN 없이 열림 · 데이터 전용(+86 번호 없음) · 한국 유심은 꽂아 둔 채 사용",
          short: "로밍형 eSIM",
          onArrival: "착륙 직후 eSIM 회선을 켜고 데이터 로밍 ON · 한국 회선은 데이터 로밍 OFF (문자 수신용으로 회선은 켜 둠)",
          perPersonKRW: range(7000, 22000),
          sourceRef: NET.guide,
          sourceRef2: sourceRef("China Neighbor - 전화번호 있는 중국 eSIM (2026-09, 10-07 갱신)", "https://chinaneighbor.com/ko/guide/essentials/china-esim-with-phone-number", "여행용 eSIM은 데이터가 본토 필터링 바깥으로 흘러 구글·왓츠앱·인스타그램이 VPN 없이 됩니다. Airalo는 1GB당 $4.50부터(1-10GB에 약 $4.50-12)입니다. 4일간 3-10GB를 7,000-22,000원으로 추정했습니다."),
        },
        {
          id: "kr_roaming",
          title: "한국 통신사 로밍",
          subtitle: "쓰던 번호 그대로 · 설정이 가장 쉬움 · 유튜브·네이버·카카오톡이 열린다는 설명이 많지만 가입 전 통신사에 확인",
          short: "통신사 로밍",
          onArrival: "착륙 직후 데이터 로밍 ON · 로밍 요금제 적용 안내 문자 확인",
          perPersonKRW: range(25000, 49500),
          sourceRef: NET.ktRoaming,
          sourceRef2: NET.roaming,
        },
        {
          id: "local_sim",
          title: "중국 현지 유심 · 호텔 와이파이",
          subtitle: "유튜브·구글·인스타그램·카카오톡 차단, 네이버도 안 열림 · +86 번호가 생겨 징둥 인증에는 유리 · 공항 통신사 카운터에서 여권으로 구매",
          short: "현지 유심(차단)",
          onArrival: "입국장을 나와 푸둥공항 통신사 카운터에서 여권으로 유심 구매",
          perPersonKRW: range(10000, 30000),
          blockedNote: "현지 유심과 호텔 와이파이는 중국 차단을 그대로 받아 유튜브·네이버·카카오톡·구글이 열리지 않습니다. 한국 사이트를 써야 하면 로밍형 eSIM이나 통신사 로밍을 고르세요.",
          sourceRef: NET.naver,
          sourceRef2: NET.naverBlock,
        },
      ],
      noteGroups: [
        {
          title: "인터넷 · 유심",
          notes: [
            "결론: '로밍형' 여행 eSIM(또는 로밍형 유심)을 쓰면 유튜브·네이버·카카오톡·구글·인스타그램이 한국에서처럼 열립니다. 데이터가 중국 밖(홍콩·한국) 통신망으로 빠져나가 중국 차단(만리방화벽)을 거치지 않기 때문입니다. VPN은 필요 없습니다.",
            "막히는 경우: 호텔·카페 와이파이와 중국 현지망 유심은 차단을 그대로 받습니다. 유튜브·구글·인스타그램·카카오톡이 안 되고 네이버도 열리지 않습니다(2023-05부터 차단 보도, 2025-09 후기도 같음). 호텔에서도 와이파이를 끄고 모바일 데이터로 쓰세요.",
            "상품 고르기: 모든 중국 eSIM이 차단을 피하는 것은 아닙니다. 상품 설명에 'VPN 없이 유튜브·카카오톡·구글 사용 가능'이나 '홍콩 로밍망'이 적힌 것을 고르고, '중국 본토 전용'·'현지망' 상품은 피하세요.",
            "용량: 지도·검색·메신저 위주면 하루 1GB로 충분하고, 유튜브를 보면 1시간에 0.5-1GB(480-720p, 추정)를 쓰니 하루 2-3GB나 무제한이 편합니다. 속도 제한 조건(예: 하루 용량을 넘으면 저속)을 확인하세요.",
            "eSIM과 유심: 휴대폰이 eSIM을 지원하면 eSIM이 편합니다. 한국 유심을 그대로 꽂아 두므로 카드사·알리페이 인증 문자를 받을 수 있습니다(한국 회선은 데이터 로밍만 끄기). 실물 유심으로 갈아 끼우면 한국 번호 문자를 못 받으니 인증이 필요한 일은 출국 전에 끝내세요.",
            "통신사 로밍: 쓰던 번호 그대로라 가장 간편하고, 국내 통신망을 거쳐 차단을 받지 않는다는 설명이 많습니다. 다만 그렇지 않다는 자료도 있으니 가입 전에 통신사 로밍센터에 '중국에서 유튜브·네이버가 열리는지' 확인하세요.",
            "중국 번호: 로밍형 eSIM은 데이터 전용이라 +86 번호가 없습니다. 징둥처럼 중국 번호 인증이 필요한 곳은 +86 번호를 따로 마련해야 하니('처방 준비' 탭 참고), 번호가 없으면 타오바오 카드로 진행하세요.",
            "중국 앱: 알리페이·위챗·디디·가오더 지도는 어떤 방식으로도 됩니다. 구글 지도는 열려도 위치가 어긋나니 길 찾기는 가오더(高德)나 애플 지도를 쓰세요.",
            "예비책: eSIM은 출국 전에 한국에서 설치해 두세요(현지에서 켜면 개통). 데이터가 끊길 때를 대비해 호텔 중국어 주소·예약 확인서·항공권은 화면 캡처로 저장해 두세요.",
          ],
        },
      ],
      staysPre: [
        {
          id: "same_hotel",
          title: "첫날부터 같은 4성급 호텔 (연박)",
          subtitle: "택배를 받을 호텔에 도착일부터 묵기 · 처방일에 이동 없음 · 요금은 아래 숙소 카드로 계산",
          short: "같은 호텔",
          sameAsStayA: true,
          sourceRef: sourceRef("계획 - 택배 수령 호텔 연박", "https://www.booking.com/city/cn/shanghai.html", "타오바오·징둥 냉장 택배를 프런트가 대신 받아야 하므로, 처방 전에 다른 숙소에 묵지 않고 첫날부터 같은 호텔에 묵습니다. 주문할 때 이미 체크인한 상태라 투숙객 확인이 쉽습니다."),
        },
      ],
      flights: [
        {
          id: "cjj_pvg",
          title: "춘추항공 청주 ↔ 푸둥",
          subtitle: "직항 약 2시간 · LCC라 위탁 수하물은 별도일 수 있음(예약 때 확인)",
          airport: "PVG",
          from: "CJJ",
          priceKRW: range(230000, 400000),
          sourceRef: sourceRef("KAYAK - 청주→상하이 푸둥 왕복 참고값", "https://www.kayak.co.kr/항공권/청주국제공항-CJJ/상하이-푸둥국제공항-PVG", "최근 검색 기준 왕복 최저 226,610원이고, 최저가는 대부분 춘추항공입니다. 출발 10일 전 토요일 출발이라 23-40만 원으로 올려 잡았습니다. 위탁 수하물을 사면 더 붙습니다."),
          sourceRef2: sourceRef("굿모닝충청 - 춘추항공 청주-상하이 정기노선 취항(2026-04)", "https://www.goodmorningcc.com/news/articleView.html?idxno=445170", "9C7050 월·금·토 12:05 → 13:10, 귀국 9C7049 08:00 → 11:05. 6/3부터 매일 운항. 동계 시간표는 예약할 때 다시 확인하세요."),
        },
      ],
      airportTransfers: [
        {
          id: "pvg_metro_taxi",
          title: "갈 때 지하철 · 올 때 새벽 택시",
          subtitle: "지하철 2호선으로 인민광장까지 약 1시간 · 귀국일은 05시대 디디·택시(1대 170-240위안)",
          short: "지하철+새벽 택시",
          shortIn: "지하철 2호선",
          shortOut: "05시 디디·택시로 푸둥 (08:00 9C7049)",
          airports: ["PVG"],
          perPersonRoundtripCNY: range(7, 9),
          perVehicleRoundtripCNY: range(170, 240),
          vehicleCapacity: 4,
          sourceRef: sourceRef("Wander in China - 상하이 공항 교통(Shanghai Airport Transport, 2026-07)", "https://www.wanderinchina.com/en/destinations/shanghai/transport/airport/", "푸둥 → 와이탄·옛 프랑스 조계 택시 180-250위안, 23시-5시 30% 할증입니다. 귀국일 05시 이후 출발이면 할증이 없습니다. 지하철 2호선 약 7위안·1시간, 자기부상 편도 50위안(당일 항공권 제시 40위안)입니다."),
        },
        {
          id: "pvg_maglev_taxi",
          title: "갈 때 자기부상 · 올 때 새벽 택시",
          subtitle: "자기부상으로 룽양루까지 8분 + 지하철 환승 · 귀국일은 05시대 택시(자기부상 첫차 06:45 무렵은 08:00편에 늦음)",
          short: "자기부상+새벽 택시",
          shortIn: "자기부상 + 지하철",
          shortOut: "05시 디디·택시로 푸둥 (08:00 9C7049)",
          airports: ["PVG"],
          perPersonRoundtripCNY: range(43, 55),
          perVehicleRoundtripCNY: range(170, 240),
          vehicleCapacity: 4,
          sourceRef: sourceRef("Wander in China - 상하이 공항 교통(Shanghai Airport Transport, 2026-07)", "https://www.wanderinchina.com/en/destinations/shanghai/transport/airport/", "푸둥 → 와이탄·옛 프랑스 조계 택시 180-250위안, 23시-5시 30% 할증입니다. 귀국일 05시 이후 출발이면 할증이 없습니다. 지하철 2호선 약 7위안·1시간, 자기부상 편도 50위안(당일 항공권 제시 40위안)입니다."),
        },
        {
          id: "pvg_taxi",
          title: "갈 때·올 때 모두 택시",
          subtitle: "푸둥 ↔ 시내 45-60분 · 1대 4인(짐 많으면 3인)",
          short: "택시",
          airports: ["PVG"],
          perVehicleRoundtripCNY: range(360, 540),
          vehicleCapacity: 4,
          sourceRef: sourceRef("Wander in China - 상하이 공항 교통(Shanghai Airport Transport, 2026-07)", "https://www.wanderinchina.com/en/destinations/shanghai/transport/airport/", "푸둥 → 와이탄·옛 프랑스 조계 180-250위안, 23시-5시 30% 할증입니다. 편도 1대 180-270위안으로 가정했습니다."),
        },
      ],
      // 청주공항까지 자차 운전 · 출발 11/28 10시 전후 입차, 12/01 11:05 착륙 뒤 출차(약 73-74시간)
      homeParking: [
        {
          id: "cjj_p34",
          title: "청주공항 제3·4주차장 (공영)",
          subtitle: "공항공사 직영 평면 · 24시간마다 최대 6,000원 · 1·2주차장보다 터미널에서 멂",
          short: "제3·4주차장",
          airports: ["CJJ"],
          dayBasis: "24h",
          perDayKRW: range(6000, 6000),
          extraKRW: range(1500, 4000),
          vehicleCapacity: 5,
          sourceRef: sourceRef("한국공항공사 청주공항 - 주차안내", "https://www.airport.co.kr/cheongju/cms/frCon/index.do?MENU_ID=170&CONTENTS_NO=2", "소형 제3·4주차장: 최초 10분 무료, 1시간 1,000원, 6시간 이후 1일 최대 6,000원, 24시간 단위 반복. 장기주차 할인 없음. 경차·저공해차 50%(행정정보 자동 조회). 자투리 1-2시간과 귀국 지연분을 1,500-4,000원으로 잡았습니다."),
        },
        {
          id: "cjj_p12",
          title: "청주공항 제1·2주차장·주차빌딩 (공영)",
          subtitle: "터미널에서 가까움 · 24시간마다 최대 10,000원 · 짐 많을 때",
          short: "제1·2주차장",
          airports: ["CJJ"],
          dayBasis: "24h",
          perDayKRW: range(10000, 10000),
          extraKRW: range(1500, 4000),
          vehicleCapacity: 5,
          sourceRef: sourceRef("한국공항공사 청주공항 - 주차안내", "https://www.airport.co.kr/cheongju/cms/frCon/index.do?MENU_ID=170&CONTENTS_NO=2", "소형 제1·2주차장·주차빌딩: 최초 10분 무료, 1시간 1,000원, 10시간 이후 1일 최대 10,000원, 24시간 단위 반복. 장기주차 할인 없음."),
        },
        {
          id: "cjj_central",
          title: "청주공항 센트럴파킹 (민영 · 주차대행)",
          subtitle: "공항 밖 민영 · 금·토·일 9,000원 · 평일 8,000원 · 대행료 10,000원 · 실시간 예약",
          short: "센트럴파킹",
          airports: ["CJJ"],
          dayBasis: "calendar",
          perDayKRW: range(8000, 9000),
          onceKRW: range(10000, 10000),
          vehicleCapacity: 5,
          sourceRef: sourceRef("청주공항 센트럴파킹센터 - 요금 안내", "https://centralparking.kr/info", "2026-07-01부터 1일 평일 8,000원(할인가), 금·토·일 9,000원, 8일차부터 4,000원, 주차대행료 10,000원 별도(이벤트에 따라 변동). 05-08시·19시 이후 입차 예약은 예약금 10,000원. 문의 1555-3315. 달력 날짜 단위로 계산했습니다."),
        },
      ],
      staysA: [
        {
          id: "intl_4star",
          short: "4성급 호텔",
          title: "4성급 국제 체인 호텔 (인민광장·난징루·징안)",
          subtitle: "홀리데이인·코트야드·노보텔급 · 프런트·컨시어지(礼宾部) 24시간 · 미니바 냉장고 · 택배 대리 수령이 가장 확실",
          perRoomPerNightCNY: range(650, 1000),
          booking: "People's Square, Shanghai",
          bookingFilter: "class=4",
          sourceRef: sourceRef("Booking.com - 상하이(Shanghai) 4성급 참고값", "https://www.booking.com/city/cn/shanghai.html", "4성급 평균 $100(약 720위안)을 바탕으로 평일 트윈룸 1실 요금을 650-1,000위안으로 추정했습니다. 토요일 밤은 숙박 배율 ×1.25가 붙습니다. Booking에서 별 4개 필터로 고르고, 예약 확정 뒤 호텔에 '냉장 택배 대리 수령·냉장 보관'을 메시지로 확인하세요."),
        },
        {
          id: "atour",
          short: "아투어",
          title: "아투어(亚朵) 호텔 (난징둥루·와이탄)",
          subtitle: "중국 체인 고급형(高档型, 4성급 수준) · 24시간 프런트가 택배 보관 · 객실 냉장고는 예약 때 확인 · 컨시어지 데스크는 없는 지점 많음",
          perRoomPerNightCNY: range(620, 900),
          booking: "Atour Hotel Nanjing East Road The Bund Shanghai",
          sourceRef: sourceRef("Booking.com - 상하이(Shanghai) 12월 참고값", "https://www.booking.com/city/cn/shanghai.html", "아투어 인민광장점(Atour People's Square) 최저가는 $156.55입니다(조회 시점, 주말 포함). 이를 바탕으로 평일 트윈룸 요금을 추정했습니다. 4성급 평균은 $100(약 710위안)입니다."),
        },
        {
          id: "radisson_newworld",
          short: "래디슨 블루",
          title: "래디슨 블루 뉴월드 (인민광장)",
          subtitle: "고급 · 컨시어지(礼宾部) 상주 · 난징루 보행가 앞 · 지하철 3개 노선 · 미니바 냉장고",
          perRoomPerNightCNY: range(900, 1350),
          booking: "Radisson Blu Hotel Shanghai New World",
          sourceRef: sourceRef("Booking.com - 상하이(Shanghai) 12월 참고값", "https://www.booking.com/city/cn/shanghai.html", "최저가 $248.48(조회 시점, 주말 포함)을 바탕으로 평일 트윈룸 요금을 추정했습니다. 5성급 평균은 $162(약 1,150위안)입니다."),
        },
      ],
      staysB: [
        { id: "none", title: "없음 (같은 호텔 연박)", subtitle: "이동 없이 상하이에 집중" },
        {
          id: "suzhou_old_town",
          title: "쑤저우 구시가 1박 (핑장루·산탕제)",
          subtitle: "고속철 25-35분 · 정원·운하 야경 · 조식 별도",
          short: "쑤저우",
          perRoomPerNightCNY: range(450, 800),
          transferPerPersonCNY: range(60, 110),
          booking: "Suzhou",
          sourceRef: sourceRef("Booking.com - 쑤저우(Suzhou) 12월 참고값", "https://www.booking.com/city/cn/suzhou.html", "4성급 평균 $67 · 5성급 평균 $115, Pan Pacific Suzhou $72, 핑장루 Xingle Hotel $58을 바탕으로 구시가 트윈룸 1실 요금을 추정했습니다. 이동은 고속철 2등석 편도 12-40위안에 지하철 왕복을 더했습니다."),
        },
        {
          id: "disney_toystory",
          title: "디즈니 토이스토리 호텔 1박",
          subtitle: "리조트 셔틀 · 푸둥공항 가까움 · 12/16 새 호텔 개장으로 붐빔",
          short: "디즈니 호텔",
          perRoomPerNightCNY: range(1000, 1800),
          transferPerPersonCNY: range(12, 25),
          booking: "Toy Story Hotel Shanghai Disney Resort",
          sourceRef: sourceRef("신랑신원(新浪新闻) - 상하이 디즈니 싱위안 호텔 12/16 개장(上海迪士尼星愿酒店, 2026-11-10)", "https://news.sina.cn/2026-11-10/detail-iniyhfqw9202843.d.html", "세 번째 테마 호텔인 싱위안 호텔(星愿酒店)이 2026-12-16에 문을 엽니다. 연말까지 1박 3,562-9,199위안입니다. 토이스토리 호텔 평일 1,000-1,800위안은 여행 글을 바탕으로 한 추정이며 서비스료가 따로 붙을 수 있습니다. 이동은 지하철 11호선과 공항선으로 가정했습니다."),
        },
      ],
      transports: [
        {
          id: "transit",
          title: "지하철",
          subtitle: "해외 비접촉 카드 탭 · 알리페이 승차코드 · 1회 3위안부터",
          perPersonPerDayCNY: range(15, 35),
          sourceRef: sourceRef("Cities Insider - 상하이 지하철 이용 안내(上海地铁系统指南, 2026)", "https://citiesinsider.com/country/china/shanghai/metro-system/zh", "기본 3위안(6km), 10km마다 1위안 추가, 1일권 18위안 · 3일권 45위안입니다. 2025-06부터 모든 개찰구에서 Visa·Master 등 해외 비접촉 카드를 찍을 수 있습니다. 2026-08에 요금 인상안 청문회가 열려 조금 오를 수 있습니다."),
        },
        {
          id: "transit_taxi",
          title: "지하철 + 디디 보조",
          subtitle: "하루 1-2회 디디·택시 (기본요금 14-16위안)",
          perPersonPerDayCNY: range(30, 75),
          sourceRef: sourceRef("추정 - 디디 단거리 1대 20-45위안", "https://www.numbeo.com/cost-of-living/in/Shanghai", "Numbeo 상하이 기준 택시 기본요금은 14.5위안에 km당 3위안입니다. 2-4인이 1대를 나눠 탄다고 가정했습니다."),
        },
        {
          id: "transit_charter1",
          title: "지하철 + 전세 밴 1일",
          subtitle: "쑤저우·주자자오 날 1일만 기사 포함 밴",
          perPersonPerDayCNY: range(15, 35),
          perGroupOnceCNY: range(900, 1600),
          sourceRef: sourceRef("추정 - 7-9인승 밴 8-10시간", "https://www.booking.com/city/cn/shanghai.html", "기사 포함 밴 1대를 하루 900-1,600위안으로 추정했습니다. 고속도로 통행료 포함 여부를 확인하세요."),
        },
      ],
      activities: [
        {
          id: "disney",
          title: "상하이 디즈니랜드 1일권",
          kind: "qty",
          min: 0,
          max: 1,
          slot: "full",
          timeline: "상하이 디즈니랜드 (지하철 11호선)",
          note: "입장권 + 지하철 왕복 · 날짜별 가격",
          adultCNY: range(490, 680),
          peakAdultCNY: range(700, 815),
          sourceRef: sourceRef("Wander in China - 상하이 디즈니 입장권(Shanghai Disney Tickets, 2026-08)", "https://www.wanderinchina.com/en/destinations/shanghai/disneyland/tickets/", "성인 1일권은 475-799위안입니다. 2025-10부터 중간 가격대가 생겼고, 날짜별 가격은 30일 전부터 공개됩니다. 12월 평일은 최저가대, 주말·크리스마스·연말은 상위 가격대로 가정하고 지하철 왕복 약 15위안을 더했습니다."),
        },
        {
          id: "suzhou",
          title: "쑤저우 당일 (졸정원·핑장루)",
          kind: "qty",
          min: 0,
          max: 1,
          slot: "full",
          timeline: "쑤저우 당일치기 (고속철 25-35분)",
          note: "B숙소를 쑤저우로 고르면 빼기",
          adultCNY: range(140, 260),
          sourceRef: sourceRef("Cities Insider - 쑤저우 교통 안내(苏州交通指南, 2026)", "https://citiesinsider.com/country/china/suzhou/transportation/zh", "상하이-쑤저우 고속철 2등석 12-40위안, 25-35분, 쑤저우 지하철 2-8위안입니다. 왕복 교통에 정원 입장료 70-90위안과 간식을 더해 가정했습니다. 기차표는 여권 실명으로 예매합니다."),
        },
        {
          id: "zhujiajiao",
          title: "주자자오 수향마을 반나절",
          kind: "qty",
          min: 0,
          max: 1,
          slot: "half",
          timeline: "주자자오 수향마을 (지하철 17호선)",
          adultCNY: range(20, 130),
          sourceRef: sourceRef("Ctrip - 주자자오 고진(朱家角古镇)", "https://gs.ctrip.com/html5/you/sight/176.html", "마을 입장은 무료로 표기돼 있고, 명소 3곳 통합권은 55위안입니다. 지하철 17호선 왕복 약 16위안에 통합권과 나룻배(선택)를 더해 가정했습니다."),
        },
        {
          id: "yuyuan",
          title: "예원(豫园) 정원 + 위위안 상가",
          kind: "toggle",
          defaultOn: true,
          slot: "half",
          allowedDays: [0, 2, 3, 4, 5, 6],
          timeline: "예원(豫园) 정원 (9:00-16:30, 16시 입장 마감) · 구곡교·위위안 상가",
          note: "월요일 휴관 · 오후 늦게 정원 → 불 켜진 상가 순서 추천 · 동한춘당 중약박물관이 바로 옆",
          adultCNY: range(30, 40),
          sourceRef: sourceRef("GoAsia - 예원 가이드(Yu Garden Shanghai, 2026-10)", "https://goasia.cc/en/article/yu-garden-shanghai", "화-일 9:00-16:30(16:00 입장 마감), 월요일 휴관(일부 공휴일 제외). 성인 성수기 40위안·비수기 30위안. 입장권은 매표소나 공식 위챗 미니프로그램에서 삽니다. 트립콤파니 영상(2024-12)은 오후 늦게 정원을 보고 조명이 켜진 상가를 구경하는 순서를 권합니다."),
        },
        {
          id: "kpgXintiandi",
          title: "대한민국 임시정부청사 + 신톈디(新天地)",
          kind: "toggle",
          defaultOn: true,
          slot: "half",
          allowedDays: [0, 2, 3, 4, 5, 6],
          timeline: "대한민국 임시정부청사 (마당루 306룽) · 신톈디 스쿠먼 거리 산책",
          note: "월요일 휴관 · 9:00-11:30, 13:30-17:00 · 내부 촬영 금지 · 신톈디 카페는 비싼 편",
          adultCNY: range(20, 20),
          sourceRef: sourceRef("트립스토어 - 상하이 대한민국 임시정부청사 방문 팁", "https://www.tripstore.kr/blog/%EC%83%81%ED%95%98%EC%9D%B4-%EB%8C%80%ED%95%9C%EB%AF%BC%EA%B5%AD-%EC%9E%84%EC%8B%9C%EC%A0%95%EB%B6%80%EC%B2%AD%EC%82%AC", "성인 20위안, 월요일 휴관, 9:00-11:30·13:30-17:00(30분 전 입장 마감), 내부 촬영 금지. 2026-08-01~09-14 전시 보수로 휴관했으니 재개관 여부를 출발 전에 확인하세요(연합뉴스 2026-07-12). 신톈디는 바로 옆입니다."),
        },
        {
          id: "pudongRiverside",
          title: "푸둥 빈장 산책로 · 일낙장랑(日落长廊) + 동방명주 공중회랑",
          kind: "toggle",
          defaultOn: true,
          slot: "half",
          timeline: "푸둥 빈장 산책로 일낙장랑(日落长廊) · 동방명주 원형 공중회랑 · 정다광장(正大广场)",
          note: "산책은 무료(간식비만 가정) · 강 건너로 와이탄 건물이 보임",
          adultCNY: range(0, 40),
          sourceRef: sourceRef("트립콤파니 - 상하이에서 해야 하는 것들(YouTube, 2024-12)", "https://www.youtube.com/watch?v=avRg0Ee-E8s", "푸둥 황푸강변은 산책로 중심이며 지도에서 일낙장랑(日落长廊)을 검색하면 됩니다. 상하이 타워 전망대를 본 뒤 푸시로 돌아가기 전에 걸어 보기를 권합니다. 수코 브이로그(2026-06)는 예원에서 페리로 건너 동방명주 공중회랑·정다광장으로 이어지는 동선을 보여 줍니다. 간식비는 추정입니다."),
        },
        {
          id: "shanghaiTower",
          title: "상하이 타워 전망대 + 루자쭈이",
          kind: "qty",
          min: 0,
          max: 1,
          slot: "half",
          timeline: "상하이 타워 118층 전망대",
          adultCNY: range(160, 180),
          sourceRef: sourceRef("다허퍄오우왕(大河票务网) - 상하이 타워 톱 오브 상하이 전망대(上海中心大厦 上海之巅观光厅)", "https://www.dahepiao.com/lvyounews1/20250527514585.html", "성인 180위안, 8:30-22:00, 지하철 2호선 루자쭈이역 6번 출구입니다. 2025-05 게시글이며, 온라인 예매 할인을 가정했습니다."),
        },
        {
          id: "tangquan",
          title: "24시간 온천 사우나 수이궈탕취안(水裹·汤泉)",
          kind: "qty",
          min: 0,
          max: 1,
          slot: "full",
          tag: "이색 체험",
          timeline: "수이궈탕취안(水裹·汤泉) 훙차오점·우자오창점 종일",
          note: "16시간권 평일 238위안·주말 298위안 · 02-06시 체류는 69위안 추가(조식 포함) · 과일·음료 무제한 · 22시 이후 입장·숙박은 여권 원본 필요",
          adultCNY: range(238, 307),
          sourceRef: sourceRef("취날(去哪儿) - 수이궈탕취안 우자오창점(水裹·汤泉 五角场店) 238위안 숙박 실측", "https://travelnews.qunar.com/ugc/shanghai-wujiaochang-bath-238", "평일 16시간 238위안, 주말·공휴일 298위안입니다. 02:00 이후 숙박은 69위안 추가이며 129위안짜리 조식 뷔페가 포함됩니다. 휴식홀에 소파베드·벌집 캡슐·통나무 칸막이가 있고, 게임방(电竞房)·영화관(影院)·동굴 휴게실(洞穴休息区)도 있습니다. 24시간 영업하며 지하철 10호선 우자오창역 5번 출구에서 도보 8분입니다. 키 1.2m 이하는 무료입니다."),
          sourceRef2: sourceRef("KKday - 수이궈탕취안 훙차오점(水裹·汤泉 虹桥店) 판매 안내", "https://www.kkday.com/zh-my/product/925533", "24시간 영업하며 입장 시각부터 24시간마다 정산합니다. 02:00-06:00 체류는 1인 69위안(조식 1식 포함)입니다. 22시 이후 입장·숙박은 본인 신분증 원본으로 프런트에 등록합니다. 수영복 착용 금지인 알몸 입욕(裸汤)이고, 남녀 목욕 구역이 나뉩니다. 18,000㎡, 민항구 선빈난루 1010호 룽후 훙차오 톈제(闵行区申滨南路1010号 龙湖虹桥天街) B1."),
        },
        {
          id: "tcmMuseum",
          title: "상하이 중의약박물관 (푸둥 장장)",
          kind: "qty",
          min: 0,
          max: 1,
          slot: "half",
          allowedDays: [0, 2, 3, 4, 5, 6],
          tag: "처방 테마",
          timeline: "상하이 중의약박물관 · 백초원 (상하이중의약대)",
          note: "월요일 휴관 · 입장 15위안 + 지하철 왕복",
          adultCNY: range(25, 45),
          sourceRef: sourceRef("차이나데일리(China Daily) - 상하이 중의약박물관(Shanghai Museum of Traditional Chinese Medicine)", "https://govt.chinadaily.com.cn/a/201904/29/WS5cd90ae9498e079e6802029f.html", "푸둥신구 차이룬루 1200호(浦东新区蔡伦路1200号), 상하이중의약대 안. 9:00-16:00, 월요일 휴관, 일반 15위안입니다. 2019년 게시글이라 방문 전 bwg.shutcm.edu.cn에서 다시 확인하세요."),
        },
        {
          id: "oldPharmacy",
          title: "위위안 동한춘당(童涵春堂) 중약박물관 + 난징둥루 약국 거리",
          kind: "toggle",
          defaultOn: true,
          slot: "half",
          allowedDays: [0, 2, 3, 4, 6],
          tag: "처방 테마",
          timeline: "동한춘당(童涵春堂) 중약박물관 · 난징둥루 제일의약상점",
          note: "무료 · 박물관은 월·금 휴관, 9-11시·13-16시",
          groupCNY: range(0, 0),
          sourceRef: sourceRef("chinaservicesinfo - 동한춘당 중약박물관(Tonghanchuntang Traditional Chinese Medicine Museum)", "https://www.chinaservicesinfo.com/s/202306/14/WS648982eb498ea274927bf73f/tonghanchuntang-traditional-chinese-medicine-museum.html", "황푸구 위위안신루 20호(黄浦区豫园新路20号) 3층, 9:00-11:00 · 13:00-16:00, 월·금 휴관, 무료"),
          sourceRef2: sourceRef("텐센트 뉴스 - 상하이 약국 감량 주사 구매 새 규정(上海药店购买减重针新规, 2026-05-15)", "https://news.qq.com/rain/a/20260515A07V3600", "난징둥루 제일의약상점(第一医药商店)과 레이윈상(雷允上)은 5/15부터 오프라인 병원의 종이 처방전(3일 이내)이 있어야 세마글루타이드·터제파타이드를 팝니다. 병원에 재고가 없을 때 처방전을 들고 가서 사는 곳입니다."),
        },
        {
          id: "breakfast4",
          cash: true,
          title: "아침 4대 금강(四大金刚) · 다빙·유탸오·츠판·더우장",
          kind: "qty",
          min: 0,
          max: 2,
          slot: "morning",
          tag: "이색 식사",
          timeline: "아침 동네 조식집 '4대 금강' (6-9시)",
          note: "노점·개인 QR은 해외 카드가 안 됨",
          adultCNY: range(8, 20),
          sourceRef: sourceRef("당다이중궈(当代中国) - 상하이 아침 4대 금강(上海早餐 四大金刚)", "https://www.ourchinastory.com/cn/9056", "상하이 전통 서민 아침 4종은 구운 빵 다빙(大饼)·튀긴 꽈배기 유탸오(油条)·찹쌀 주먹밥 츠판퇀(粢饭团)·두유 더우장(豆浆)입니다. 가게와 가격은 나와 있지 않아 1끼 가격을 추정했습니다. 호텔 근처 조식집은 다중뎬핑(大众点评)에서 검색하세요."),
        },
        {
          id: "xiaolong",
          title: "샤오룽바오·성젠 순례 (황허루·난징둥루)",
          kind: "qty",
          min: 0,
          max: 2,
          slot: "lunch",
          timeline: "점심 샤오룽바오·성젠바오 (예원 난샹만터우뎬 南翔馒头店 또는 황허루)",
          adultCNY: range(40, 90),
          sourceRef: sourceRef("추정 - 샤오룽바오 1판 15-45위안 · 성젠 4개 9-16위안", "https://www.numbeo.com/cost-of-living/in/Shanghai", "Numbeo 상하이 저가 식당 1끼는 30위안(25-50)입니다. 자자탕바오(佳家汤包)·샤오양성젠(小杨生煎)·다후춘(大壶春) 등 2-3곳을 도는 가격으로 추정했습니다."),
        },
        {
          id: "wuzhongMarket",
          cash: true,
          title: "우중시장(乌中市集) 2층 반찬·간단식 + 우캉루",
          kind: "qty",
          min: 0,
          max: 1,
          slot: "lunch",
          tag: "이색 식사",
          timeline: "점심 우중시장 2층 반찬·간단식 (우루무치중루 318호)",
          note: "프라다 협업으로 유명해진 동네 재래시장",
          adultCNY: range(30, 70),
          sourceRef: sourceRef("펑파이신문(澎湃新闻)·신랑차이징 - 우중시장(乌中市集, 2021-11)", "https://finance.sina.cn/2021-11-25/detail-ikyamrmy4941917.d.html", "쉬후이구 우루무치중루 318호(徐汇区乌鲁木齐中路318号), 2,000㎡ 2층 건물로 2019년 말 개보수했습니다. 1층은 채소·해산물·꽃, 2층은 반조리 식품·조리 반찬(熟食)·건어물과 간단식·음료 가게입니다. 새벽 5-6시에 열고 17시쯤 붐빕니다. 1끼 가격은 추정입니다."),
        },
        {
          id: "canteen",
          title: "66우퉁위안(66梧桐院) 주민식당 · 톈핑린리후이(天平邻里汇)",
          kind: "qty",
          min: 0,
          max: 1,
          slot: "lunch",
          tag: "이색 식사",
          timeline: "점심 66우퉁위안 주민식당 (10:30-13:00, 우루무치난루)",
          note: "후덱 설계 양옥 안 구립 식당 · 누구나 이용",
          adultCNY: range(20, 40),
          sourceRef: sourceRef("펑파이신문(澎湃新闻) - 혀끝의 상하이: 시 전체 주민식당 지도(舌尖上海 | 全市社区食堂地图, 2023-08)", "https://m.thepaper.cn/newsDetail_forward_24277164", "66우퉁위안(66梧桐院)·톈핑린리후이(天平邻里汇) 3호동 식당은 우루무치난루 65호(乌鲁木齐南路65号)에 있고 10:30-13:00 · 16:30-21:00에 엽니다. 외부인도 이용할 수 있고 1인 20위안대, 요리는 3-16위안입니다. 위위안 주민식당도 대안입니다. 팡방중루 235호(方浜中路235号), 10:30-13:30 · 16:10-19:30."),
          sourceRef2: sourceRef("신원천바오(新闻晨报)·광밍왕 - 주민식당 탐방(社区食堂探访, 2025-09)", "https://m.gmw.cn/2025-09/10/content_1304143099.htm", "66우퉁위안(66梧桐院)은 하루 약 80가지 요리를 내고, 토마토달걀볶음 6위안 · 마파두부 8위안입니다. 주민식당은 모든 시민에게 열려 있습니다."),
        },
        {
          id: "bund",
          title: "와이탄 야경 산책 + 황푸강 페리",
          kind: "toggle",
          defaultOn: true,
          slot: "evening",
          timeline: "난징둥루 보행가 → 와이탄 야경 (겨울 18시쯤 점등) · 페리로 루자쭈이 건너기",
          note: "산책은 무료 · 페리 편도 2위안 · 겨울 18시쯤 점등, 22-23시쯤 소등",
          adultCNY: range(2, 4),
          sourceRef: sourceRef("Wander in China - 상하이 교통(Shanghai Transport, 2026-07)", "https://www.wanderinchina.com/en/destinations/shanghai/transport/", "황푸강 시민 페리 둥진선(东金线)은 2위안, 약 10분, 대략 7-22시 운항입니다. 왕복으로 가정했습니다."),
        },
        {
          id: "rooftopBar",
          title: "호텔 인디고 30층 루프탑 바(CHAR) 야경",
          kind: "qty",
          min: 0,
          max: 1,
          slot: "evening",
          timeline: "호텔 인디고 30층 루프탑 바(CHAR) · 와이탄·루자쭈이를 한 번에",
          note: "입장+칵테일 묶음 · 평일 1잔 약 100위안, 주말 2잔 약 200위안(2024 기준) · 복장 자유로운 편",
          adultCNY: range(100, 200),
          sourceRef: sourceRef("트립콤파니 - 상하이에서 해야 하는 것들(YouTube, 2024-12)", "https://www.youtube.com/watch?v=avRg0Ee-E8s", "와이탄 남쪽 호텔 인디고 루프탑 바는 입장료와 칵테일을 묶어 팔고, 평일 1잔 2만 원·주말 2잔 4만 원이 기본입니다. 푸둥 루자쭈이와 푸시 와이탄을 멀리서 한 번에 봅니다. 수코 브이로그(2026-06)도 30층 CHAR 바를 야경 스팟으로 소개합니다. 위안 환산은 추정입니다."),
        },
        {
          id: "specialDinner",
          title: "특식 디너 · 번방차이(本帮菜)·상하이 털게",
          kind: "qty",
          min: 0,
          max: 2,
          slot: "evening",
          dinner: true,
          timeline: "특식 디너",
          note: "식비 카드와 별도인 추가분 · 털게는 12월까지 제철",
          adultCNY: range(200, 500),
          sourceRef: sourceRef("Numbeo - 상하이(Shanghai)", "https://www.numbeo.com/cost-of-living/in/Shanghai", "중급 식당 2인 3코스는 200위안(150-400)입니다. 번방차이 노포·털게(12월까지 제철) 코스 기준으로 추정했습니다. 식비 레벨과 별도인 추가분입니다."),
        },
      ],
      packs: [
        { id: "pack_first", title: "첫 상하이 정석", subtitle: "예원 + 임시정부청사·신톈디 + 푸둥 강변 + 와이탄 + 루프탑 바", apply: { yuyuan: true, kpgXintiandi: true, pudongRiverside: true, bund: true, rooftopBar: 1, oldPharmacy: false, disney: 0, suzhou: 0 } },
        { id: "pack_rx_light", title: "처방 + 가벼운 관광", subtitle: "조식집 + 중의약박물관 + 옛 약국 + 와이탄", apply: { disney: 0, suzhou: 0, breakfast4: 1, tcmMuseum: 1, oldPharmacy: true, xiaolong: 1, bund: true } },
        { id: "pack_odd_food", title: "이색 식사", subtitle: "4대 금강 2 + 재래시장 + 주민식당 + 샤오룽 순례", apply: { breakfast4: 2, wuzhongMarket: 1, canteen: 1, xiaolong: 1 } },
        { id: "pack_daytrip", title: "근교 당일", subtitle: "쑤저우 + 주자자오", apply: { suzhou: 1, zhujiajiao: 1 } },
        { id: "pack_disney", title: "디즈니", subtitle: "상하이 디즈니랜드 + 와이탄 야경", apply: { disney: 1, bund: true } },
      ],
      defaults: {
        flightId: "cjj_pvg",
        airportId: "pvg_metro_taxi",
        parkingId: "cjj_p34",
        dataId: "esim_roam",
        clinicId: "taobao_cold",
        stayPreId: "same_hotel",
        roomConfigId: "occ2",
        stayAId: "intl_4star",
        stayBId: "none",
        mealId: "mixed",
        transportId: "transit",
        activities: { disney: 0, suzhou: 0, zhujiajiao: 0, yuyuan: true, kpgXintiandi: true, pudongRiverside: true, shanghaiTower: 0, tangquan: 0, tcmMuseum: 0, oldPharmacy: false, breakfast4: 1, xiaolong: 1, wuzhongMarket: 1, canteen: 0, bund: true, rooftopBar: 1, specialDinner: 1 },
      },
    },
  };

  window.TRIP_DATA = {
    meta: {
      appId: "china_sha_cjj",
      locale: "ko-KR",
      currency: "KRW",
      asOf: AS_OF,
      region: "Shanghai from Cheongju (CJJ), 2026-11-28 to 12-01 draft, Mounjaro prescription trip",
      notes: [
        "현지 가격은 위안 기준 P10-P90 범위이고, 항공권은 원화 범위입니다.",
        "숙박비는 세금·봉사료를 포함한 평일가에 날짜별 배율을 곱합니다. 숙박세가 있는 숙소는 별도 줄로 계산합니다.",
"결과는 '평균 1인'(총액÷총인원)의 예상값과 80% 범위입니다. 마운자로 약값과 청주공항 주차비도 총액에 들어갑니다.",
      ],
      sharedSources: [SRC.cnVisa, SRC.fxCny, SRC.cnAlipay, NET.caution],
      sharedGroupTitle: "공통 · 마운자로 반입·가격·보관 · 계산 방식·환율·시기·객실·식비",
    },
    calculationRules,
    countries,
    currencies,
    party,
    durations,
    departures,
    seasons,
    rx,
    roomConfigs,
    mealLevels,
    cityOrder: ["shanghai"],
    initial: { durationId: "n3", seasonId: "w1128", rxDayId: "rx_d1" },
    cities,
  };
})();
