/**
 * Egypt's governorates and their main districts. The SAME list is installed in production by the
 * migration `20261005110000_egypt_governorates`, so local development and production always offer
 * the same places in the venue sign-up form.
 */
export interface SeedDistrict {
  id: string;
  slug: string;
  nameEn: string;
  nameAr: string;
  lat: number;
  lng: number;
}
export interface SeedGovernorate {
  id: string;
  slug: string;
  nameEn: string;
  nameAr: string;
  districts: SeedDistrict[];
}

export const EGYPT_GEO: SeedGovernorate[] = [
  {
    id: 'gov-cairo', slug: 'cairo', nameEn: 'Cairo', nameAr: 'القاهرة',
    districts: [
      { id: 'dist-nasr-city', slug: 'nasr-city', nameEn: 'Nasr City', nameAr: 'مدينة نصر', lat: 30.0511, lng: 31.3656 },
      { id: 'dist-maadi', slug: 'maadi', nameEn: 'Maadi', nameAr: 'المعادي', lat: 29.9602, lng: 31.2505 },
      { id: 'dist-new-cairo', slug: 'new-cairo', nameEn: 'New Cairo', nameAr: 'القاهرة الجديدة', lat: 30.0074, lng: 31.4913 },
      { id: 'dist-heliopolis', slug: 'heliopolis', nameEn: 'Heliopolis', nameAr: 'مصر الجديدة', lat: 30.0876, lng: 31.3225 },
      { id: 'dist-zamalek', slug: 'zamalek', nameEn: 'Zamalek', nameAr: 'الزمالك', lat: 30.0626, lng: 31.2197 },
      { id: 'dist-downtown', slug: 'downtown', nameEn: 'Downtown', nameAr: 'وسط البلد', lat: 30.0444, lng: 31.2357 },
      { id: 'dist-shorouk', slug: 'shorouk', nameEn: 'El Shorouk', nameAr: 'الشروق', lat: 30.1217, lng: 31.6025 },
      { id: 'dist-madinaty', slug: 'madinaty', nameEn: 'Madinaty', nameAr: 'مدينتي', lat: 30.1075, lng: 31.6395 },
      { id: 'dist-mokattam', slug: 'mokattam', nameEn: 'Mokattam', nameAr: 'المقطم', lat: 30.0131, lng: 31.3189 },
      { id: 'dist-shubra', slug: 'shubra', nameEn: 'Shubra', nameAr: 'شبرا', lat: 30.1128, lng: 31.2456 },
      { id: 'dist-ain-shams', slug: 'ain-shams', nameEn: 'Ain Shams', nameAr: 'عين شمس', lat: 30.1312, lng: 31.319 },
      { id: 'dist-helwan', slug: 'helwan', nameEn: 'Helwan', nameAr: 'حلوان', lat: 29.8414, lng: 31.3008 },
    ],
  },
  {
    id: 'gov-giza', slug: 'giza', nameEn: 'Giza', nameAr: 'الجيزة',
    districts: [
      { id: 'dist-6october', slug: '6th-of-october', nameEn: '6th of October', nameAr: '6 أكتوبر', lat: 29.9729, lng: 30.9447 },
      { id: 'dist-sheikh-zayed', slug: 'sheikh-zayed', nameEn: 'Sheikh Zayed', nameAr: 'الشيخ زايد', lat: 30.049, lng: 30.976 },
      { id: 'dist-dokki', slug: 'dokki', nameEn: 'Dokki', nameAr: 'الدقي', lat: 30.0382, lng: 31.2118 },
      { id: 'dist-mohandessin', slug: 'mohandessin', nameEn: 'Mohandessin', nameAr: 'المهندسين', lat: 30.0561, lng: 31.2003 },
      { id: 'dist-agouza', slug: 'agouza', nameEn: 'Agouza', nameAr: 'العجوزة', lat: 30.0553, lng: 31.2108 },
      { id: 'dist-haram', slug: 'haram', nameEn: 'Haram', nameAr: 'الهرم', lat: 29.987, lng: 31.1342 },
      { id: 'dist-faisal', slug: 'faisal', nameEn: 'Faisal', nameAr: 'فيصل', lat: 29.9896, lng: 31.171 },
      { id: 'dist-imbaba', slug: 'imbaba', nameEn: 'Imbaba', nameAr: 'إمبابة', lat: 30.077, lng: 31.206 },
    ],
  },
  {
    id: 'gov-alexandria', slug: 'alexandria', nameEn: 'Alexandria', nameAr: 'الإسكندرية',
    districts: [
      { id: 'dist-smouha', slug: 'smouha', nameEn: 'Smouha', nameAr: 'سموحة', lat: 31.2156, lng: 29.9425 },
      { id: 'dist-sidi-gaber', slug: 'sidi-gaber', nameEn: 'Sidi Gaber', nameAr: 'سيدي جابر', lat: 31.2209, lng: 29.9461 },
      { id: 'dist-san-stefano', slug: 'san-stefano', nameEn: 'San Stefano', nameAr: 'سان ستيفانو', lat: 31.245, lng: 29.965 },
      { id: 'dist-gleem', slug: 'gleem', nameEn: 'Gleem', nameAr: 'جليم', lat: 31.237, lng: 29.961 },
      { id: 'dist-miami', slug: 'miami', nameEn: 'Miami', nameAr: 'ميامي', lat: 31.268, lng: 29.99 },
      { id: 'dist-montaza', slug: 'montaza', nameEn: 'Montaza', nameAr: 'المنتزه', lat: 31.287, lng: 30.015 },
      { id: 'dist-mansheya', slug: 'mansheya', nameEn: 'Mansheya', nameAr: 'المنشية', lat: 31.1955, lng: 29.894 },
      { id: 'dist-agami', slug: 'agami', nameEn: 'Agami', nameAr: 'العجمي', lat: 31.107, lng: 29.76 },
      { id: 'dist-borg-el-arab', slug: 'borg-el-arab', nameEn: 'Borg El Arab', nameAr: 'برج العرب', lat: 30.8483, lng: 29.542 },
    ],
  },
  {
    id: 'gov-qalyubia', slug: 'qalyubia', nameEn: 'Qalyubia', nameAr: 'القليوبية',
    districts: [
      { id: 'dist-banha', slug: 'banha', nameEn: 'Banha', nameAr: 'بنها', lat: 30.466, lng: 31.185 },
      { id: 'dist-shubra-el-kheima', slug: 'shubra-el-kheima', nameEn: 'Shubra El Kheima', nameAr: 'شبرا الخيمة', lat: 30.1286, lng: 31.2422 },
      { id: 'dist-qalyub', slug: 'qalyub', nameEn: 'Qalyub', nameAr: 'قليوب', lat: 30.179, lng: 31.206 },
      { id: 'dist-obour', slug: 'obour', nameEn: 'El Obour', nameAr: 'العبور', lat: 30.228, lng: 31.477 },
      { id: 'dist-khanka', slug: 'khanka', nameEn: 'El Khanka', nameAr: 'الخانكة', lat: 30.216, lng: 31.362 },
      { id: 'dist-shibin-el-qanater', slug: 'shibin-el-qanater', nameEn: 'Shibin El Qanater', nameAr: 'شبين القناطر', lat: 30.307, lng: 31.315 },
    ],
  },
  {
    id: 'gov-port-said', slug: 'port-said', nameEn: 'Port Said', nameAr: 'بورسعيد',
    districts: [
      { id: 'dist-port-said-city', slug: 'port-said-city', nameEn: 'Port Said', nameAr: 'بورسعيد', lat: 31.2653, lng: 32.3019 },
      { id: 'dist-port-fouad', slug: 'port-fouad', nameEn: 'Port Fouad', nameAr: 'بور فؤاد', lat: 31.242, lng: 32.315 },
    ],
  },
  {
    id: 'gov-suez', slug: 'suez', nameEn: 'Suez', nameAr: 'السويس',
    districts: [
      { id: 'dist-suez-city', slug: 'suez-city', nameEn: 'Suez City', nameAr: 'مدينة السويس', lat: 29.9668, lng: 32.5498 },
      { id: 'dist-ain-sokhna', slug: 'ain-sokhna', nameEn: 'Ain Sokhna', nameAr: 'العين السخنة', lat: 29.589, lng: 32.349 },
    ],
  },
  {
    id: 'gov-dakahlia', slug: 'dakahlia', nameEn: 'Dakahlia', nameAr: 'الدقهلية',
    districts: [
      { id: 'dist-mansoura', slug: 'mansoura', nameEn: 'Mansoura', nameAr: 'المنصورة', lat: 31.0409, lng: 31.3785 },
      { id: 'dist-talkha', slug: 'talkha', nameEn: 'Talkha', nameAr: 'طلخا', lat: 31.054, lng: 31.378 },
      { id: 'dist-mit-ghamr', slug: 'mit-ghamr', nameEn: 'Mit Ghamr', nameAr: 'ميت غمر', lat: 30.714, lng: 31.259 },
      { id: 'dist-belqas', slug: 'belqas', nameEn: 'Belqas', nameAr: 'بلقاس', lat: 31.226, lng: 31.36 },
    ],
  },
  {
    id: 'gov-sharqia', slug: 'sharqia', nameEn: 'Sharqia', nameAr: 'الشرقية',
    districts: [
      { id: 'dist-zagazig', slug: 'zagazig', nameEn: 'Zagazig', nameAr: 'الزقازيق', lat: 30.5877, lng: 31.502 },
      { id: 'dist-10th-of-ramadan', slug: '10th-of-ramadan', nameEn: '10th of Ramadan', nameAr: 'العاشر من رمضان', lat: 30.29, lng: 31.75 },
      { id: 'dist-belbeis', slug: 'belbeis', nameEn: 'Belbeis', nameAr: 'بلبيس', lat: 30.42, lng: 31.56 },
    ],
  },
  {
    id: 'gov-gharbia', slug: 'gharbia', nameEn: 'Gharbia', nameAr: 'الغربية',
    districts: [
      { id: 'dist-tanta', slug: 'tanta', nameEn: 'Tanta', nameAr: 'طنطا', lat: 30.7865, lng: 31.0004 },
      { id: 'dist-mahalla', slug: 'mahalla', nameEn: 'El Mahalla El Kubra', nameAr: 'المحلة الكبرى', lat: 30.97, lng: 31.1669 },
      { id: 'dist-kafr-el-zayat', slug: 'kafr-el-zayat', nameEn: 'Kafr El Zayat', nameAr: 'كفر الزيات', lat: 30.824, lng: 30.815 },
      { id: 'dist-zefta', slug: 'zefta', nameEn: 'Zefta', nameAr: 'زفتى', lat: 30.714, lng: 31.243 },
    ],
  },
  {
    id: 'gov-monufia', slug: 'monufia', nameEn: 'Monufia', nameAr: 'المنوفية',
    districts: [
      { id: 'dist-shebin-el-kom', slug: 'shebin-el-kom', nameEn: 'Shebin El Kom', nameAr: 'شبين الكوم', lat: 30.559, lng: 31.01 },
      { id: 'dist-menouf', slug: 'menouf', nameEn: 'Menouf', nameAr: 'منوف', lat: 30.465, lng: 30.934 },
      { id: 'dist-sadat-city', slug: 'sadat-city', nameEn: 'Sadat City', nameAr: 'مدينة السادات', lat: 30.365, lng: 30.519 },
      { id: 'dist-ashmoun', slug: 'ashmoun', nameEn: 'Ashmoun', nameAr: 'أشمون', lat: 30.297, lng: 30.976 },
    ],
  },
  {
    id: 'gov-beheira', slug: 'beheira', nameEn: 'Beheira', nameAr: 'البحيرة',
    districts: [
      { id: 'dist-damanhur', slug: 'damanhur', nameEn: 'Damanhur', nameAr: 'دمنهور', lat: 31.0341, lng: 30.4682 },
      { id: 'dist-kafr-el-dawar', slug: 'kafr-el-dawar', nameEn: 'Kafr El Dawar', nameAr: 'كفر الدوار', lat: 31.134, lng: 30.129 },
      { id: 'dist-rashid', slug: 'rashid', nameEn: 'Rashid', nameAr: 'رشيد', lat: 31.404, lng: 30.417 },
      { id: 'dist-abu-hummus', slug: 'abu-hummus', nameEn: 'Abu Hummus', nameAr: 'أبو حمص', lat: 31.09, lng: 30.307 },
    ],
  },
  {
    id: 'gov-kafr-el-sheikh', slug: 'kafr-el-sheikh', nameEn: 'Kafr El Sheikh', nameAr: 'كفر الشيخ',
    districts: [
      { id: 'dist-kafr-el-sheikh-city', slug: 'kafr-el-sheikh-city', nameEn: 'Kafr El Sheikh', nameAr: 'كفر الشيخ', lat: 31.1107, lng: 30.9388 },
      { id: 'dist-desouk', slug: 'desouk', nameEn: 'Desouk', nameAr: 'دسوق', lat: 31.136, lng: 30.647 },
      { id: 'dist-baltim', slug: 'baltim', nameEn: 'Baltim', nameAr: 'بلطيم', lat: 31.558, lng: 31.078 },
    ],
  },
  {
    id: 'gov-damietta', slug: 'damietta', nameEn: 'Damietta', nameAr: 'دمياط',
    districts: [
      { id: 'dist-damietta-city', slug: 'damietta-city', nameEn: 'Damietta', nameAr: 'دمياط', lat: 31.4165, lng: 31.8133 },
      { id: 'dist-ras-el-bar', slug: 'ras-el-bar', nameEn: 'Ras El Bar', nameAr: 'رأس البر', lat: 31.515, lng: 31.83 },
      { id: 'dist-faraskur', slug: 'faraskur', nameEn: 'Faraskur', nameAr: 'فارسكور', lat: 31.329, lng: 31.716 },
    ],
  },
  {
    id: 'gov-ismailia', slug: 'ismailia', nameEn: 'Ismailia', nameAr: 'الإسماعيلية',
    districts: [
      { id: 'dist-ismailia-city', slug: 'ismailia-city', nameEn: 'Ismailia', nameAr: 'الإسماعيلية', lat: 30.5965, lng: 32.2715 },
      { id: 'dist-fayed', slug: 'fayed', nameEn: 'Fayed', nameAr: 'فايد', lat: 30.33, lng: 32.303 },
      { id: 'dist-qantara', slug: 'qantara', nameEn: 'El Qantara', nameAr: 'القنطرة غرب', lat: 30.856, lng: 32.315 },
    ],
  },
  {
    id: 'gov-north-sinai', slug: 'north-sinai', nameEn: 'North Sinai', nameAr: 'شمال سيناء',
    districts: [
      { id: 'dist-arish', slug: 'arish', nameEn: 'El Arish', nameAr: 'العريش', lat: 31.1316, lng: 33.7984 },
      { id: 'dist-bir-al-abd', slug: 'bir-al-abd', nameEn: 'Bir al-Abd', nameAr: 'بئر العبد', lat: 31.015, lng: 33.0 },
    ],
  },
  {
    id: 'gov-south-sinai', slug: 'south-sinai', nameEn: 'South Sinai', nameAr: 'جنوب سيناء',
    districts: [
      { id: 'dist-sharm-el-sheikh', slug: 'sharm-el-sheikh', nameEn: 'Sharm El Sheikh', nameAr: 'شرم الشيخ', lat: 27.9158, lng: 34.33 },
      { id: 'dist-dahab', slug: 'dahab', nameEn: 'Dahab', nameAr: 'دهب', lat: 28.5091, lng: 34.5136 },
      { id: 'dist-nuweiba', slug: 'nuweiba', nameEn: 'Nuweiba', nameAr: 'نويبع', lat: 29.036, lng: 34.659 },
      { id: 'dist-el-tor', slug: 'el-tor', nameEn: 'El Tor', nameAr: 'الطور', lat: 28.2414, lng: 33.6224 },
      { id: 'dist-saint-catherine', slug: 'saint-catherine', nameEn: 'Saint Catherine', nameAr: 'سانت كاترين', lat: 28.556, lng: 33.95 },
    ],
  },
  {
    id: 'gov-fayoum', slug: 'fayoum', nameEn: 'Fayoum', nameAr: 'الفيوم',
    districts: [
      { id: 'dist-fayoum-city', slug: 'fayoum-city', nameEn: 'Fayoum City', nameAr: 'مدينة الفيوم', lat: 29.3084, lng: 30.8428 },
      { id: 'dist-sinnuris', slug: 'sinnuris', nameEn: 'Sinnuris', nameAr: 'سنورس', lat: 29.414, lng: 30.868 },
      { id: 'dist-tamiya', slug: 'tamiya', nameEn: 'Tamiya', nameAr: 'طامية', lat: 29.474, lng: 30.966 },
      { id: 'dist-ibsheway', slug: 'ibsheway', nameEn: 'Ibsheway', nameAr: 'إبشواي', lat: 29.361, lng: 30.68 },
    ],
  },
  {
    id: 'gov-beni-suef', slug: 'beni-suef', nameEn: 'Beni Suef', nameAr: 'بني سويف',
    districts: [
      { id: 'dist-beni-suef-city', slug: 'beni-suef-city', nameEn: 'Beni Suef City', nameAr: 'مدينة بني سويف', lat: 29.0661, lng: 31.0994 },
      { id: 'dist-new-beni-suef', slug: 'new-beni-suef', nameEn: 'New Beni Suef', nameAr: 'بني سويف الجديدة', lat: 29.15, lng: 31.16 },
      { id: 'dist-el-wasta', slug: 'el-wasta', nameEn: 'El Wasta', nameAr: 'الواسطى', lat: 29.34, lng: 31.2 },
      { id: 'dist-nasser', slug: 'nasser', nameEn: 'Nasser', nameAr: 'ناصر', lat: 28.97, lng: 31.17 },
      { id: 'dist-ihnasya', slug: 'ihnasya', nameEn: 'Ihnasya', nameAr: 'إهناسيا', lat: 29.075, lng: 30.934 },
      { id: 'dist-beba', slug: 'beba', nameEn: 'Beba', nameAr: 'ببا', lat: 28.917, lng: 30.983 },
      { id: 'dist-fashn', slug: 'fashn', nameEn: 'El Fashn', nameAr: 'الفشن', lat: 28.825, lng: 30.899 },
    ],
  },
  {
    id: 'gov-minya', slug: 'minya', nameEn: 'Minya', nameAr: 'المنيا',
    districts: [
      { id: 'dist-minya-city', slug: 'minya-city', nameEn: 'Minya City', nameAr: 'مدينة المنيا', lat: 28.1099, lng: 30.7503 },
      { id: 'dist-mallawi', slug: 'mallawi', nameEn: 'Mallawi', nameAr: 'ملوي', lat: 27.731, lng: 30.841 },
      { id: 'dist-samalut', slug: 'samalut', nameEn: 'Samalut', nameAr: 'سمالوط', lat: 28.312, lng: 30.711 },
      { id: 'dist-maghagha', slug: 'maghagha', nameEn: 'Maghagha', nameAr: 'مغاغة', lat: 28.648, lng: 30.842 },
      { id: 'dist-beni-mazar', slug: 'beni-mazar', nameEn: 'Beni Mazar', nameAr: 'بني مزار', lat: 28.496, lng: 30.807 },
    ],
  },
  {
    id: 'gov-assiut', slug: 'assiut', nameEn: 'Assiut', nameAr: 'أسيوط',
    districts: [
      { id: 'dist-assiut-city', slug: 'assiut-city', nameEn: 'Assiut City', nameAr: 'مدينة أسيوط', lat: 27.18, lng: 31.1837 },
      { id: 'dist-abnub', slug: 'abnub', nameEn: 'Abnub', nameAr: 'أبنوب', lat: 27.268, lng: 31.151 },
      { id: 'dist-dairut', slug: 'dairut', nameEn: 'Dairut', nameAr: 'ديروط', lat: 27.556, lng: 30.81 },
      { id: 'dist-manfalut', slug: 'manfalut', nameEn: 'Manfalut', nameAr: 'منفلوط', lat: 27.313, lng: 30.965 },
      { id: 'dist-qusiya', slug: 'qusiya', nameEn: 'El Qusiya', nameAr: 'القوصية', lat: 27.441, lng: 30.818 },
    ],
  },
  {
    id: 'gov-sohag', slug: 'sohag', nameEn: 'Sohag', nameAr: 'سوهاج',
    districts: [
      { id: 'dist-sohag-city', slug: 'sohag-city', nameEn: 'Sohag City', nameAr: 'مدينة سوهاج', lat: 26.5569, lng: 31.6948 },
      { id: 'dist-akhmim', slug: 'akhmim', nameEn: 'Akhmim', nameAr: 'أخميم', lat: 26.564, lng: 31.744 },
      { id: 'dist-girga', slug: 'girga', nameEn: 'Girga', nameAr: 'جرجا', lat: 26.338, lng: 31.889 },
      { id: 'dist-tahta', slug: 'tahta', nameEn: 'Tahta', nameAr: 'طهطا', lat: 26.77, lng: 31.502 },
    ],
  },
  {
    id: 'gov-qena', slug: 'qena', nameEn: 'Qena', nameAr: 'قنا',
    districts: [
      { id: 'dist-qena-city', slug: 'qena-city', nameEn: 'Qena City', nameAr: 'مدينة قنا', lat: 26.1551, lng: 32.716 },
      { id: 'dist-nag-hammadi', slug: 'nag-hammadi', nameEn: 'Nag Hammadi', nameAr: 'نجع حمادي', lat: 26.049, lng: 32.241 },
      { id: 'dist-qus', slug: 'qus', nameEn: 'Qus', nameAr: 'قوص', lat: 25.914, lng: 32.76 },
      { id: 'dist-dishna', slug: 'dishna', nameEn: 'Dishna', nameAr: 'دشنا', lat: 26.128, lng: 32.463 },
    ],
  },
  {
    id: 'gov-luxor', slug: 'luxor', nameEn: 'Luxor', nameAr: 'الأقصر',
    districts: [
      { id: 'dist-luxor-city', slug: 'luxor-city', nameEn: 'Luxor City', nameAr: 'مدينة الأقصر', lat: 25.6872, lng: 32.6396 },
      { id: 'dist-armant', slug: 'armant', nameEn: 'Armant', nameAr: 'أرمنت', lat: 25.615, lng: 32.533 },
      { id: 'dist-esna', slug: 'esna', nameEn: 'Esna', nameAr: 'إسنا', lat: 25.293, lng: 32.554 },
    ],
  },
  {
    id: 'gov-aswan', slug: 'aswan', nameEn: 'Aswan', nameAr: 'أسوان',
    districts: [
      { id: 'dist-aswan-city', slug: 'aswan-city', nameEn: 'Aswan City', nameAr: 'مدينة أسوان', lat: 24.0889, lng: 32.8998 },
      { id: 'dist-edfu', slug: 'edfu', nameEn: 'Edfu', nameAr: 'إدفو', lat: 24.978, lng: 32.873 },
      { id: 'dist-kom-ombo', slug: 'kom-ombo', nameEn: 'Kom Ombo', nameAr: 'كوم أمبو', lat: 24.457, lng: 32.928 },
      { id: 'dist-abu-simbel', slug: 'abu-simbel', nameEn: 'Abu Simbel', nameAr: 'أبو سمبل', lat: 22.3372, lng: 31.6258 },
    ],
  },
  {
    id: 'gov-red-sea', slug: 'red-sea', nameEn: 'Red Sea', nameAr: 'البحر الأحمر',
    districts: [
      { id: 'dist-hurghada', slug: 'hurghada', nameEn: 'Hurghada', nameAr: 'الغردقة', lat: 27.2579, lng: 33.8116 },
      { id: 'dist-el-gouna', slug: 'el-gouna', nameEn: 'El Gouna', nameAr: 'الجونة', lat: 27.395, lng: 33.676 },
      { id: 'dist-safaga', slug: 'safaga', nameEn: 'Safaga', nameAr: 'سفاجا', lat: 26.749, lng: 33.938 },
      { id: 'dist-el-quseir', slug: 'el-quseir', nameEn: 'El Quseir', nameAr: 'القصير', lat: 26.104, lng: 34.278 },
      { id: 'dist-marsa-alam', slug: 'marsa-alam', nameEn: 'Marsa Alam', nameAr: 'مرسى علم', lat: 25.067, lng: 34.896 },
    ],
  },
  {
    id: 'gov-matrouh', slug: 'matrouh', nameEn: 'Matrouh', nameAr: 'مطروح',
    districts: [
      { id: 'dist-marsa-matrouh', slug: 'marsa-matrouh', nameEn: 'Marsa Matrouh', nameAr: 'مرسى مطروح', lat: 31.3543, lng: 27.2373 },
      { id: 'dist-el-alamein', slug: 'el-alamein', nameEn: 'El Alamein', nameAr: 'العلمين', lat: 30.833, lng: 28.954 },
      { id: 'dist-el-dabaa', slug: 'el-dabaa', nameEn: 'El Dabaa', nameAr: 'الضبعة', lat: 31.036, lng: 28.444 },
      { id: 'dist-siwa', slug: 'siwa', nameEn: 'Siwa', nameAr: 'سيوة', lat: 29.203, lng: 25.519 },
    ],
  },
  {
    id: 'gov-new-valley', slug: 'new-valley', nameEn: 'New Valley', nameAr: 'الوادي الجديد',
    districts: [
      { id: 'dist-kharga', slug: 'kharga', nameEn: 'Kharga', nameAr: 'الخارجة', lat: 25.439, lng: 30.5586 },
      { id: 'dist-dakhla', slug: 'dakhla', nameEn: 'Dakhla', nameAr: 'الداخلة', lat: 25.496, lng: 29.002 },
      { id: 'dist-farafra', slug: 'farafra', nameEn: 'Farafra', nameAr: 'الفرافرة', lat: 27.058, lng: 27.97 },
    ],
  },
];
