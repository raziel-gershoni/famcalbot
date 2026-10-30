// The cities of the public zmanim pages (spec docs/superpowers/specs/2026-10-30-public-zmanim-design.md §5.1 and
// Appendix A): one row per city, Israel first, then the other countries in the spec's order. Plain data, client-safe: it
// imports nothing, so the "Near me" island can ship it.
//
// - slug: lowercase ASCII English, the same in every language. A slug never changes after launch, and rows are only
//   added (scripts/smoke-cities.ts pins the count).
// - geonameId, latitude and longitude (4 decimals) and timeZone: from the GeoNames dump (cities5000, 2026-10-30;
//   CC BY 4.0, credited on the zmanim pages). Every Israeli city has Asia/Jerusalem, Judea and Samaria included (never
//   Asia/Hebron): the zone is the engine's Israel flag (inIsrael), for the Yom Tov days, the height and the Sephardi end
//   of Shabbat. Zones are IANA names (Europe/Kyiv): compare a zone ICU resolved only after normalising it, since Node's
//   ICU may answer Europe/Kiev.
// - country: the ISO 3166 code; 'IL' for every Israeli city (GeoNames files Ma'ale Adumim and Beitar Illit under PS).
// - elevationM: the highest ground in an Israeli town, in whole metres, written by scripts/build-city-heights.ts by the
//   bot's own rule (elevationGrid over the town's OpenStreetMap box, read from the Copernicus DEM GLO-90). Null abroad,
//   where every set counts at sea level. A negative height, if one ever appears, is kept as read; the engine clamps it to 0.
//
// The names are in messages: cities.<slug> and countries.<country>, in en, he and ru.

export type City = {
  slug: string;
  geonameId: number;
  country: string;
  latitude: number;
  longitude: number;
  timeZone: string;
  elevationM: number | null;
};

export const CITIES: readonly City[] = [
  // Israel (51)
  { slug: 'jerusalem', geonameId: 281184, country: 'IL', latitude: 31.7690, longitude: 35.2163, timeZone: 'Asia/Jerusalem', elevationM: 828 },
  { slug: 'tel-aviv', geonameId: 293397, country: 'IL', latitude: 32.0809, longitude: 34.7806, timeZone: 'Asia/Jerusalem', elevationM: 65 },
  { slug: 'haifa', geonameId: 294801, country: 'IL', latitude: 32.8130, longitude: 34.9993, timeZone: 'Asia/Jerusalem', elevationM: 296 },
  { slug: 'rishon-lezion', geonameId: 293703, country: 'IL', latitude: 31.9710, longitude: 34.7894, timeZone: 'Asia/Jerusalem', elevationM: 71 },
  { slug: 'petah-tikva', geonameId: 293918, country: 'IL', latitude: 32.0888, longitude: 34.8867, timeZone: 'Asia/Jerusalem', elevationM: 76 },
  { slug: 'ashdod', geonameId: 295629, country: 'IL', latitude: 31.7921, longitude: 34.6497, timeZone: 'Asia/Jerusalem', elevationM: 32 },
  { slug: 'netanya', geonameId: 294071, country: 'IL', latitude: 32.3329, longitude: 34.8592, timeZone: 'Asia/Jerusalem', elevationM: 46 },
  { slug: 'beer-sheva', geonameId: 295530, country: 'IL', latitude: 31.2518, longitude: 34.7913, timeZone: 'Asia/Jerusalem', elevationM: 372 },
  { slug: 'bnei-brak', geonameId: 295514, country: 'IL', latitude: 32.0807, longitude: 34.8338, timeZone: 'Asia/Jerusalem', elevationM: 65 },
  { slug: 'holon', geonameId: 294751, country: 'IL', latitude: 32.0122, longitude: 34.7783, timeZone: 'Asia/Jerusalem', elevationM: 54 },
  { slug: 'ramat-gan', geonameId: 293788, country: 'IL', latitude: 32.0823, longitude: 34.8107, timeZone: 'Asia/Jerusalem', elevationM: 59 },
  { slug: 'ashkelon', geonameId: 295620, country: 'IL', latitude: 31.6693, longitude: 34.5715, timeZone: 'Asia/Jerusalem', elevationM: 56 },
  { slug: 'rehovot', geonameId: 293725, country: 'IL', latitude: 31.8941, longitude: 34.8095, timeZone: 'Asia/Jerusalem', elevationM: 78 },
  { slug: 'bat-yam', geonameId: 295548, country: 'IL', latitude: 32.0180, longitude: 34.7500, timeZone: 'Asia/Jerusalem', elevationM: 42 },
  { slug: 'beit-shemesh', geonameId: 295432, country: 'IL', latitude: 31.7307, longitude: 34.9929, timeZone: 'Asia/Jerusalem', elevationM: 528 },
  { slug: 'kfar-saba', geonameId: 294514, country: 'IL', latitude: 32.1750, longitude: 34.9069, timeZone: 'Asia/Jerusalem', elevationM: 74 },
  { slug: 'herzliya', geonameId: 294778, country: 'IL', latitude: 32.1663, longitude: 34.8254, timeZone: 'Asia/Jerusalem', elevationM: 81 },
  { slug: 'hadera', geonameId: 294946, country: 'IL', latitude: 32.4419, longitude: 34.9039, timeZone: 'Asia/Jerusalem', elevationM: 34 },
  { slug: 'modiin', geonameId: 282926, country: 'IL', latitude: 31.8939, longitude: 35.0150, timeZone: 'Asia/Jerusalem', elevationM: 300 },
  { slug: 'lod', geonameId: 294421, country: 'IL', latitude: 31.9526, longitude: 34.8917, timeZone: 'Asia/Jerusalem', elevationM: 81 },
  { slug: 'ramla', geonameId: 293768, country: 'IL', latitude: 31.9262, longitude: 34.8635, timeZone: 'Asia/Jerusalem', elevationM: 98 },
  { slug: 'raanana', geonameId: 293807, country: 'IL', latitude: 32.1836, longitude: 34.8739, timeZone: 'Asia/Jerusalem', elevationM: 76 },
  { slug: 'nof-hagalil', geonameId: 294097, country: 'IL', latitude: 32.7082, longitude: 35.3247, timeZone: 'Asia/Jerusalem', elevationM: 505 },
  { slug: 'rosh-haayin', geonameId: 293690, country: 'IL', latitude: 32.0955, longitude: 34.9544, timeZone: 'Asia/Jerusalem', elevationM: 163 },
  { slug: 'afula', geonameId: 295740, country: 'IL', latitude: 32.6091, longitude: 35.2892, timeZone: 'Asia/Jerusalem', elevationM: 167 },
  { slug: 'kiryat-gat', geonameId: 293842, country: 'IL', latitude: 31.6100, longitude: 34.7642, timeZone: 'Asia/Jerusalem', elevationM: 159 },
  { slug: 'nahariya', geonameId: 294117, country: 'IL', latitude: 33.0089, longitude: 35.0981, timeZone: 'Asia/Jerusalem', elevationM: 37 },
  { slug: 'eilat', geonameId: 295277, country: 'IL', latitude: 29.5581, longitude: 34.9482, timeZone: 'Asia/Jerusalem', elevationM: 372 },
  { slug: 'tiberias', geonameId: 293322, country: 'IL', latitude: 32.7940, longitude: 35.5315, timeZone: 'Asia/Jerusalem', elevationM: 211 },
  { slug: 'tzfat', geonameId: 293100, country: 'IL', latitude: 32.9646, longitude: 35.4960, timeZone: 'Asia/Jerusalem', elevationM: 885 },
  { slug: 'karmiel', geonameId: 294577, country: 'IL', latitude: 32.9095, longitude: 35.2977, timeZone: 'Asia/Jerusalem', elevationM: 475 },
  { slug: 'akko', geonameId: 295721, country: 'IL', latitude: 32.9281, longitude: 35.0765, timeZone: 'Asia/Jerusalem', elevationM: 17 },
  { slug: 'maale-adumim', geonameId: 282993, country: 'IL', latitude: 31.7774, longitude: 35.2987, timeZone: 'Asia/Jerusalem', elevationM: 644 },
  { slug: 'modiin-illit', geonameId: 8199378, country: 'IL', latitude: 31.9322, longitude: 35.0442, timeZone: 'Asia/Jerusalem', elevationM: 351 },
  { slug: 'beitar-illit', geonameId: 284375, country: 'IL', latitude: 31.7000, longitude: 35.1167, timeZone: 'Asia/Jerusalem', elevationM: 786 },
  { slug: 'elad', geonameId: 8428480, country: 'IL', latitude: 32.0511, longitude: 34.9570, timeZone: 'Asia/Jerusalem', elevationM: 166 },
  { slug: 'dimona', geonameId: 295328, country: 'IL', latitude: 31.0708, longitude: 35.0327, timeZone: 'Asia/Jerusalem', elevationM: 645 },
  { slug: 'hod-hasharon', geonameId: 294760, country: 'IL', latitude: 32.1591, longitude: 34.8928, timeZone: 'Asia/Jerusalem', elevationM: 75 },
  { slug: 'nes-ziona', geonameId: 294074, country: 'IL', latitude: 31.9293, longitude: 34.7987, timeZone: 'Asia/Jerusalem', elevationM: 69 },
  { slug: 'kiryat-shmona', geonameId: 293825, country: 'IL', latitude: 33.2120, longitude: 35.5704, timeZone: 'Asia/Jerusalem', elevationM: 758 },
  { slug: 'ariel', geonameId: 8199394, country: 'IL', latitude: 32.1065, longitude: 35.1845, timeZone: 'Asia/Jerusalem', elevationM: 648 },
  { slug: 'kiryat-ata', geonameId: 293845, country: 'IL', latitude: 32.8115, longitude: 35.1132, timeZone: 'Asia/Jerusalem', elevationM: 102 },
  { slug: 'kiryat-motzkin', geonameId: 293831, country: 'IL', latitude: 32.8371, longitude: 35.0776, timeZone: 'Asia/Jerusalem', elevationM: 13 },
  { slug: 'kiryat-bialik', geonameId: 293844, country: 'IL', latitude: 32.8275, longitude: 35.0858, timeZone: 'Asia/Jerusalem', elevationM: 12 },
  { slug: 'kiryat-yam', geonameId: 293822, country: 'IL', latitude: 32.8497, longitude: 35.0697, timeZone: 'Asia/Jerusalem', elevationM: 12 },
  { slug: 'givatayim', geonameId: 294999, country: 'IL', latitude: 32.0722, longitude: 34.8125, timeZone: 'Asia/Jerusalem', elevationM: 74 },
  { slug: 'yavne', geonameId: 293222, country: 'IL', latitude: 31.8781, longitude: 34.7398, timeZone: 'Asia/Jerusalem', elevationM: 45 },
  { slug: 'netivot', geonameId: 294068, country: 'IL', latitude: 31.4230, longitude: 34.5891, timeZone: 'Asia/Jerusalem', elevationM: 164 },
  { slug: 'sderot', geonameId: 293619, country: 'IL', latitude: 31.5250, longitude: 34.5969, timeZone: 'Asia/Jerusalem', elevationM: 118 },
  { slug: 'harish', geonameId: 8141842, country: 'IL', latitude: 32.4618, longitude: 35.0455, timeZone: 'Asia/Jerusalem', elevationM: 155 },
  { slug: 'zichron-yaakov', geonameId: 293067, country: 'IL', latitude: 32.5688, longitude: 34.9543, timeZone: 'Asia/Jerusalem', elevationM: 160 },
  // Abroad (84)
  { slug: 'new-york', geonameId: 5128581, country: 'US', latitude: 40.7143, longitude: -74.0060, timeZone: 'America/New_York', elevationM: null },
  { slug: 'monsey', geonameId: 5127315, country: 'US', latitude: 41.1112, longitude: -74.0685, timeZone: 'America/New_York', elevationM: null },
  { slug: 'lakewood', geonameId: 5100280, country: 'US', latitude: 40.0979, longitude: -74.2176, timeZone: 'America/New_York', elevationM: null },
  { slug: 'boston', geonameId: 4930956, country: 'US', latitude: 42.3584, longitude: -71.0598, timeZone: 'America/New_York', elevationM: null },
  { slug: 'philadelphia', geonameId: 4560349, country: 'US', latitude: 39.9524, longitude: -75.1636, timeZone: 'America/New_York', elevationM: null },
  { slug: 'baltimore', geonameId: 4347778, country: 'US', latitude: 39.2904, longitude: -76.6122, timeZone: 'America/New_York', elevationM: null },
  { slug: 'washington-dc', geonameId: 4140963, country: 'US', latitude: 38.8951, longitude: -77.0364, timeZone: 'America/New_York', elevationM: null },
  { slug: 'cleveland', geonameId: 5150529, country: 'US', latitude: 41.4995, longitude: -81.6954, timeZone: 'America/New_York', elevationM: null },
  { slug: 'detroit', geonameId: 4990729, country: 'US', latitude: 42.3314, longitude: -83.0457, timeZone: 'America/Detroit', elevationM: null },
  { slug: 'chicago', geonameId: 4887398, country: 'US', latitude: 41.8500, longitude: -87.6500, timeZone: 'America/Chicago', elevationM: null },
  { slug: 'atlanta', geonameId: 4180439, country: 'US', latitude: 33.7490, longitude: -84.3880, timeZone: 'America/New_York', elevationM: null },
  { slug: 'miami', geonameId: 4164138, country: 'US', latitude: 25.7743, longitude: -80.1937, timeZone: 'America/New_York', elevationM: null },
  { slug: 'boca-raton', geonameId: 4148411, country: 'US', latitude: 26.3587, longitude: -80.0831, timeZone: 'America/New_York', elevationM: null },
  { slug: 'dallas', geonameId: 4684888, country: 'US', latitude: 32.7831, longitude: -96.8067, timeZone: 'America/Chicago', elevationM: null },
  { slug: 'houston', geonameId: 4699066, country: 'US', latitude: 29.7633, longitude: -95.3633, timeZone: 'America/Chicago', elevationM: null },
  { slug: 'denver', geonameId: 5419384, country: 'US', latitude: 39.7392, longitude: -104.9847, timeZone: 'America/Denver', elevationM: null },
  { slug: 'phoenix', geonameId: 5308655, country: 'US', latitude: 33.4484, longitude: -112.0740, timeZone: 'America/Phoenix', elevationM: null },
  { slug: 'los-angeles', geonameId: 5368361, country: 'US', latitude: 34.0522, longitude: -118.2437, timeZone: 'America/Los_Angeles', elevationM: null },
  { slug: 'san-francisco', geonameId: 5391959, country: 'US', latitude: 37.7749, longitude: -122.4194, timeZone: 'America/Los_Angeles', elevationM: null },
  { slug: 'toronto', geonameId: 6167865, country: 'CA', latitude: 43.7064, longitude: -79.3986, timeZone: 'America/Toronto', elevationM: null },
  { slug: 'montreal', geonameId: 6077243, country: 'CA', latitude: 45.5088, longitude: -73.5878, timeZone: 'America/Toronto', elevationM: null },
  { slug: 'ottawa', geonameId: 6094817, country: 'CA', latitude: 45.4112, longitude: -75.6981, timeZone: 'America/Toronto', elevationM: null },
  { slug: 'vancouver', geonameId: 6173331, country: 'CA', latitude: 49.2497, longitude: -123.1193, timeZone: 'America/Vancouver', elevationM: null },
  { slug: 'buenos-aires', geonameId: 3435910, country: 'AR', latitude: -34.6131, longitude: -58.3772, timeZone: 'America/Argentina/Buenos_Aires', elevationM: null },
  { slug: 'sao-paulo', geonameId: 3448439, country: 'BR', latitude: -23.5475, longitude: -46.6361, timeZone: 'America/Sao_Paulo', elevationM: null },
  { slug: 'rio-de-janeiro', geonameId: 3451190, country: 'BR', latitude: -22.9064, longitude: -43.1822, timeZone: 'America/Sao_Paulo', elevationM: null },
  { slug: 'santiago', geonameId: 3871336, country: 'CL', latitude: -33.4569, longitude: -70.6483, timeZone: 'America/Santiago', elevationM: null },
  { slug: 'montevideo', geonameId: 3441575, country: 'UY', latitude: -34.9033, longitude: -56.1882, timeZone: 'America/Montevideo', elevationM: null },
  { slug: 'mexico-city', geonameId: 3530597, country: 'MX', latitude: 19.4285, longitude: -99.1277, timeZone: 'America/Mexico_City', elevationM: null },
  { slug: 'panama-city', geonameId: 3703443, country: 'PA', latitude: 8.9936, longitude: -79.5197, timeZone: 'America/Panama', elevationM: null },
  { slug: 'london', geonameId: 2643743, country: 'GB', latitude: 51.5085, longitude: -0.1257, timeZone: 'Europe/London', elevationM: null },
  { slug: 'manchester', geonameId: 2643123, country: 'GB', latitude: 53.4809, longitude: -2.2374, timeZone: 'Europe/London', elevationM: null },
  { slug: 'gateshead', geonameId: 2648773, country: 'GB', latitude: 54.9621, longitude: -1.6017, timeZone: 'Europe/London', elevationM: null },
  { slug: 'paris', geonameId: 2988507, country: 'FR', latitude: 48.8534, longitude: 2.3488, timeZone: 'Europe/Paris', elevationM: null },
  { slug: 'marseille', geonameId: 2995469, country: 'FR', latitude: 43.2970, longitude: 5.3811, timeZone: 'Europe/Paris', elevationM: null },
  { slug: 'lyon', geonameId: 2996944, country: 'FR', latitude: 45.7491, longitude: 4.8479, timeZone: 'Europe/Paris', elevationM: null },
  { slug: 'nice', geonameId: 2990440, country: 'FR', latitude: 43.7031, longitude: 7.2661, timeZone: 'Europe/Paris', elevationM: null },
  { slug: 'strasbourg', geonameId: 2973783, country: 'FR', latitude: 48.5839, longitude: 7.7455, timeZone: 'Europe/Paris', elevationM: null },
  { slug: 'berlin', geonameId: 2950159, country: 'DE', latitude: 52.5244, longitude: 13.4105, timeZone: 'Europe/Berlin', elevationM: null },
  { slug: 'frankfurt', geonameId: 2925533, country: 'DE', latitude: 50.1155, longitude: 8.6842, timeZone: 'Europe/Berlin', elevationM: null },
  { slug: 'munich', geonameId: 2867714, country: 'DE', latitude: 48.1374, longitude: 11.5755, timeZone: 'Europe/Berlin', elevationM: null },
  { slug: 'vienna', geonameId: 2761369, country: 'AT', latitude: 48.2085, longitude: 16.3721, timeZone: 'Europe/Vienna', elevationM: null },
  { slug: 'budapest', geonameId: 3054643, country: 'HU', latitude: 47.4984, longitude: 19.0404, timeZone: 'Europe/Budapest', elevationM: null },
  { slug: 'prague', geonameId: 3067696, country: 'CZ', latitude: 50.0880, longitude: 14.4208, timeZone: 'Europe/Prague', elevationM: null },
  { slug: 'warsaw', geonameId: 756135, country: 'PL', latitude: 52.2298, longitude: 21.0118, timeZone: 'Europe/Warsaw', elevationM: null },
  { slug: 'amsterdam', geonameId: 2759794, country: 'NL', latitude: 52.3740, longitude: 4.8897, timeZone: 'Europe/Amsterdam', elevationM: null },
  { slug: 'brussels', geonameId: 2800866, country: 'BE', latitude: 50.8505, longitude: 4.3488, timeZone: 'Europe/Brussels', elevationM: null },
  { slug: 'antwerp', geonameId: 2803138, country: 'BE', latitude: 51.2205, longitude: 4.4003, timeZone: 'Europe/Brussels', elevationM: null },
  { slug: 'zurich', geonameId: 2657896, country: 'CH', latitude: 47.3667, longitude: 8.5500, timeZone: 'Europe/Zurich', elevationM: null },
  { slug: 'milan', geonameId: 3173435, country: 'IT', latitude: 45.4643, longitude: 9.1895, timeZone: 'Europe/Rome', elevationM: null },
  { slug: 'rome', geonameId: 3169070, country: 'IT', latitude: 41.8919, longitude: 12.5113, timeZone: 'Europe/Rome', elevationM: null },
  { slug: 'madrid', geonameId: 3117735, country: 'ES', latitude: 40.4165, longitude: -3.7026, timeZone: 'Europe/Madrid', elevationM: null },
  { slug: 'istanbul', geonameId: 745044, country: 'TR', latitude: 41.0138, longitude: 28.9497, timeZone: 'Europe/Istanbul', elevationM: null },
  { slug: 'moscow', geonameId: 524901, country: 'RU', latitude: 55.7520, longitude: 37.6178, timeZone: 'Europe/Moscow', elevationM: null },
  { slug: 'saint-petersburg', geonameId: 498817, country: 'RU', latitude: 59.9386, longitude: 30.3141, timeZone: 'Europe/Moscow', elevationM: null },
  { slug: 'kazan', geonameId: 551487, country: 'RU', latitude: 55.7887, longitude: 49.1221, timeZone: 'Europe/Moscow', elevationM: null },
  { slug: 'nizhny-novgorod', geonameId: 520555, country: 'RU', latitude: 56.3287, longitude: 44.0020, timeZone: 'Europe/Moscow', elevationM: null },
  { slug: 'rostov-on-don', geonameId: 501175, country: 'RU', latitude: 47.2200, longitude: 39.7077, timeZone: 'Europe/Moscow', elevationM: null },
  { slug: 'yekaterinburg', geonameId: 1486209, country: 'RU', latitude: 56.8573, longitude: 60.6153, timeZone: 'Asia/Yekaterinburg', elevationM: null },
  { slug: 'novosibirsk', geonameId: 1496747, country: 'RU', latitude: 55.0226, longitude: 82.9317, timeZone: 'Asia/Novosibirsk', elevationM: null },
  { slug: 'kyiv', geonameId: 703448, country: 'UA', latitude: 50.4547, longitude: 30.5238, timeZone: 'Europe/Kyiv', elevationM: null },
  { slug: 'dnipro', geonameId: 709930, country: 'UA', latitude: 48.4666, longitude: 35.0407, timeZone: 'Europe/Kyiv', elevationM: null },
  { slug: 'odesa', geonameId: 698740, country: 'UA', latitude: 46.4857, longitude: 30.7438, timeZone: 'Europe/Kyiv', elevationM: null },
  { slug: 'kharkiv', geonameId: 706483, country: 'UA', latitude: 49.9818, longitude: 36.2548, timeZone: 'Europe/Kyiv', elevationM: null },
  { slug: 'lviv', geonameId: 702550, country: 'UA', latitude: 49.8383, longitude: 24.0232, timeZone: 'Europe/Kyiv', elevationM: null },
  { slug: 'minsk', geonameId: 625144, country: 'BY', latitude: 53.9002, longitude: 27.5665, timeZone: 'Europe/Minsk', elevationM: null },
  { slug: 'riga', geonameId: 456172, country: 'LV', latitude: 56.9460, longitude: 24.1059, timeZone: 'Europe/Riga', elevationM: null },
  { slug: 'vilnius', geonameId: 593116, country: 'LT', latitude: 54.6892, longitude: 25.2798, timeZone: 'Europe/Vilnius', elevationM: null },
  { slug: 'chisinau', geonameId: 618426, country: 'MD', latitude: 47.0090, longitude: 28.8594, timeZone: 'Europe/Chisinau', elevationM: null },
  { slug: 'tbilisi', geonameId: 611717, country: 'GE', latitude: 41.6914, longitude: 44.8341, timeZone: 'Asia/Tbilisi', elevationM: null },
  { slug: 'baku', geonameId: 587084, country: 'AZ', latitude: 40.3777, longitude: 49.8920, timeZone: 'Asia/Baku', elevationM: null },
  { slug: 'almaty', geonameId: 1526384, country: 'KZ', latitude: 43.2525, longitude: 76.9115, timeZone: 'Asia/Almaty', elevationM: null },
  { slug: 'tashkent', geonameId: 1512569, country: 'UZ', latitude: 41.2647, longitude: 69.2163, timeZone: 'Asia/Tashkent', elevationM: null },
  { slug: 'sydney', geonameId: 2147714, country: 'AU', latitude: -33.8678, longitude: 151.2073, timeZone: 'Australia/Sydney', elevationM: null },
  { slug: 'melbourne', geonameId: 2158177, country: 'AU', latitude: -37.8140, longitude: 144.9633, timeZone: 'Australia/Melbourne', elevationM: null },
  { slug: 'perth', geonameId: 2063523, country: 'AU', latitude: -31.9522, longitude: 115.8614, timeZone: 'Australia/Perth', elevationM: null },
  { slug: 'johannesburg', geonameId: 993800, country: 'ZA', latitude: -26.2023, longitude: 28.0436, timeZone: 'Africa/Johannesburg', elevationM: null },
  { slug: 'cape-town', geonameId: 3369157, country: 'ZA', latitude: -33.9258, longitude: 18.4232, timeZone: 'Africa/Johannesburg', elevationM: null },
  { slug: 'casablanca', geonameId: 2553604, country: 'MA', latitude: 33.5883, longitude: -7.6114, timeZone: 'Africa/Casablanca', elevationM: null },
  { slug: 'limassol', geonameId: 146384, country: 'CY', latitude: 34.6841, longitude: 33.0379, timeZone: 'Asia/Nicosia', elevationM: null },
  { slug: 'bangkok', geonameId: 1609350, country: 'TH', latitude: 13.7540, longitude: 100.5014, timeZone: 'Asia/Bangkok', elevationM: null },
  { slug: 'tokyo', geonameId: 1850147, country: 'JP', latitude: 35.6895, longitude: 139.6917, timeZone: 'Asia/Tokyo', elevationM: null },
  { slug: 'dubai', geonameId: 292223, country: 'AE', latitude: 25.0772, longitude: 55.3093, timeZone: 'Asia/Dubai', elevationM: null },
  { slug: 'hong-kong', geonameId: 1819729, country: 'HK', latitude: 22.2783, longitude: 114.1747, timeZone: 'Asia/Hong_Kong', elevationM: null },
];

const BY_SLUG: ReadonlyMap<string, City> = new Map(CITIES.map((city) => [city.slug, city]));

/** The city a URL names; undefined for any other slug (the page answers the site's 404). */
export function cityBySlug(slug: string): City | undefined {
  return BY_SLUG.get(slug);
}
