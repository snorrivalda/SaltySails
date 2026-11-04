# Beiðni um aðgang að AIS-gögnum fyrir leitar- og björgunarstarf

**Til:** Landhelgisgæsla Íslands, Vaktstöð siglinga
**Afrit:** sjokort@lhg.is
**Frá:** [Nafn], [björgunarsveit / félag], [sími], [netfang]
**Dagsetning:** [dags.]

---

Góðan dag,

Við [björgunarsveit / félag] erum að þróa **SaltySails**, opið og endurgjaldslaust leiðsöguforrit fyrir leit og
björgun á sjó við Ísland (https://saltysails.vercel.app). Forritið keyrir í síma og spjaldtölvu og virkar án
nettengingar. Í því eru opinber sjókort og dýpislínur Landhelgisgæslunnar, sjávarfallatöflur ykkar, veðurviðvaranir
Veðurstofunnar, leitarmynstur samkvæmt IAMSAR og rekreikningar.

Við óskum eftir **rauntímaaðgangi að AIS-gögnum** fyrir íslenska hafsvæðið til að birta í forritinu hjá
viðurkenndum notendum í útköllum og æfingum.

## Hvers vegna

- **AIS-SART, MOB-sendar og EPIRB-AIS:** forritið gefur strax viðvörun og vísar á staðinn þegar neyðarsendir finnst. Fyrir
  björgunarskip á leið á vettvang getur skipt sköpum að sjá sendinn áður en hann kemur inn á eigin AIS-tæki skipsins.
- **Samhæfing:** áhafnir sjá staðsetningu annarra björgunarskipa og loftfara (SAR) á sama korti og leitarsvæðin.
- **Öryggi:** sjálfvirk viðvörun um nálæga umferð (CPA/TCPA) við leit í slæmu skyggni.
- **Ófullnægjandi aðrar leiðir:** opnar alþjóðlegar AIS-þjónustur ná nær ekkert til Íslands. Prófun 4. nóvember 2026
  skilaði engum skipum á öllu svæðinu 60–70°N, 32–8°V.

## Hvað við biðjum um

- Rauntíma AIS-skeyti (staðsetning og kyrrstæðar upplýsingar, skeyti 1–3, 5, 9, 18, 19, 21 og 24) fyrir íslenska
  hafsvæðið. Aðgangur að gögnum frá landstöðvum dugar. Gervihnattagögn eru ekki nauðsynleg.
- Á hvaða sniði sem hentar ykkur. Forritið les nú þegar:
  - NMEA 0183 `!AIVDM`/`!AIVDO` yfir **TCP eða TLS**, með eða án IEC 61162-450 TAG-blokka,
  - eða sama snið yfir **WebSocket (wss)**.
  Notandanafn og lykilorð eða innskráningarlína við tengingu eru studd. Við getum líka lagað okkur að öðru sniði
  eða vefþjónustu.

## Meðferð gagna og aðgangsstýring

- Gögnin fara um eina milliþjónustu (relay) sem við rekum. Hún tengist straumnum ykkar og sendir aðeins áfram skip á
  því svæði sem notandi er að skoða, ásamt neyðarsendum og SAR-loftförum.
- **Aðeins viðurkenndir notendur** fá aðgang, með aðgangskóða sem við úthlutum til áhafna. Án kóða neitar þjónustan
  að starfa. Við getum takmarkað aðgang frekar ef þið óskið.
- **Engin geymsla:** gögnin eru hvorki vistuð í gagnagrunni né afhent þriðja aðila. Þau eru aðeins birt í rauntíma og
  hverfa úr forritinu þegar skip hefur ekki heyrst í 15 mínútur.
- Allar tengingar eru dulkóðaðar (HTTPS/TLS).
- Við erum tilbúin að gera **skriflegan samning** um notkun, takmarkanir og ábyrgð og að hlíta skilmálum ykkar,
  meðal annars um framsal, birtingu og lokun aðgangs.

## Tæknilegur tengiliður

[Nafn, sími, netfang]. Frumkóði forritsins er aðgengilegur ykkur til skoðunar ef óskað er.

Við yrðum þakklát fyrir fund eða símtal um hvort þetta sé mögulegt og á hvaða forsendum.

Með bestu kveðju,

[Nafn]
[Björgunarsveit / félag]

---

### Fyrir tæknifólk LHG (enska)

SaltySails relay `api/ais-lhg.js` connects outbound to the feed set in `LHG_AIS_URL` (`tcp://`, `tls://`, `ws://` or
`wss://`), with an optional `LHG_AIS_LOGIN` line sent after connecting. It accepts NMEA 0183 `!AIVDM`/`!AIVDO`,
including multi-sentence messages and IEC 61162-450 TAG blocks. It decodes on the server, filters by area and streams
decoded messages to authenticated clients only (`LHG_RELAY_TOKEN`). The relay runs on Vercel (serverless functions)
and has no fixed outbound IP. If IP allow-listing is required, we can run it on a host with a fixed address instead.
