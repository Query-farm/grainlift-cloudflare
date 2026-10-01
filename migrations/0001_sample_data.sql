-- Sample data for the Grainlift D1 gateway. Figures are rounded approximations
-- for demonstration, not authoritative statistics.

CREATE TABLE countries (
  code TEXT PRIMARY KEY NOT NULL,      -- ISO 3166-1 alpha-2
  name TEXT NOT NULL,
  continent TEXT NOT NULL,
  population INTEGER NOT NULL,
  area_km2 REAL NOT NULL
);

CREATE TABLE cities (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  country_code TEXT NOT NULL REFERENCES countries (code),
  population INTEGER NOT NULL,
  latitude REAL NOT NULL,
  longitude REAL NOT NULL,
  is_capital BOOLEAN NOT NULL DEFAULT 0
);

INSERT INTO countries (code, name, continent, population, area_km2) VALUES
  ('AR', 'Argentina', 'South America', 46000000, 2780400),
  ('AU', 'Australia', 'Oceania', 26600000, 7692024),
  ('BR', 'Brazil', 'South America', 216000000, 8515767),
  ('CA', 'Canada', 'North America', 40000000, 9984670),
  ('CN', 'China', 'Asia', 1410000000, 9596961),
  ('DE', 'Germany', 'Europe', 84000000, 357588),
  ('EG', 'Egypt', 'Africa', 112000000, 1001450),
  ('ES', 'Spain', 'Europe', 48000000, 505990),
  ('FR', 'France', 'Europe', 68000000, 551695),
  ('GB', 'United Kingdom', 'Europe', 68000000, 243610),
  ('IN', 'India', 'Asia', 1430000000, 3287263),
  ('IT', 'Italy', 'Europe', 59000000, 301340),
  ('JP', 'Japan', 'Asia', 124000000, 377975),
  ('KE', 'Kenya', 'Africa', 55000000, 580367),
  ('MX', 'Mexico', 'North America', 129000000, 1964375),
  ('NG', 'Nigeria', 'Africa', 224000000, 923768),
  ('NZ', 'New Zealand', 'Oceania', 5200000, 268021),
  ('US', 'United States', 'North America', 335000000, 9833520),
  ('ZA', 'South Africa', 'Africa', 62000000, 1221037),
  ('KR', 'South Korea', 'Asia', 51700000, 100210);

INSERT INTO cities (name, country_code, population, latitude, longitude, is_capital) VALUES
  ('Buenos Aires', 'AR', 15600000, -34.6037, -58.3816, 1),
  ('Córdoba', 'AR', 1600000, -31.4201, -64.1888, 0),
  ('Canberra', 'AU', 470000, -35.2809, 149.1300, 1),
  ('Sydney', 'AU', 5300000, -33.8688, 151.2093, 0),
  ('Melbourne', 'AU', 5100000, -37.8136, 144.9631, 0),
  ('Brasília', 'BR', 4800000, -15.7975, -47.8919, 1),
  ('São Paulo', 'BR', 22400000, -23.5505, -46.6333, 0),
  ('Rio de Janeiro', 'BR', 13600000, -22.9068, -43.1729, 0),
  ('Ottawa', 'CA', 1500000, 45.4215, -75.6972, 1),
  ('Toronto', 'CA', 6400000, 43.6532, -79.3832, 0),
  ('Vancouver', 'CA', 2700000, 49.2827, -123.1207, 0),
  ('Beijing', 'CN', 21800000, 39.9042, 116.4074, 1),
  ('Shanghai', 'CN', 29200000, 31.2304, 121.4737, 0),
  ('Berlin', 'DE', 3800000, 52.5200, 13.4050, 1),
  ('Munich', 'DE', 1500000, 48.1351, 11.5820, 0),
  ('Cairo', 'EG', 22600000, 30.0444, 31.2357, 1),
  ('Madrid', 'ES', 6800000, 40.4168, -3.7038, 1),
  ('Barcelona', 'ES', 5700000, 41.3874, 2.1686, 0),
  ('Paris', 'FR', 11200000, 48.8566, 2.3522, 1),
  ('Lyon', 'FR', 1700000, 45.7640, 4.8357, 0),
  ('London', 'GB', 9600000, 51.5072, -0.1276, 1),
  ('Manchester', 'GB', 2800000, 53.4808, -2.2426, 0),
  ('New Delhi', 'IN', 33800000, 28.6139, 77.2090, 1),
  ('Mumbai', 'IN', 21700000, 19.0760, 72.8777, 0),
  ('Bengaluru', 'IN', 14000000, 12.9716, 77.5946, 0),
  ('Rome', 'IT', 4300000, 41.9028, 12.4964, 1),
  ('Milan', 'IT', 3200000, 45.4642, 9.1900, 0),
  ('Tokyo', 'JP', 37100000, 35.6762, 139.6503, 1),
  ('Osaka', 'JP', 19000000, 34.6937, 135.5023, 0),
  ('Nairobi', 'KE', 5300000, -1.2921, 36.8219, 1),
  ('Mexico City', 'MX', 22500000, 19.4326, -99.1332, 1),
  ('Guadalajara', 'MX', 5500000, 20.6597, -103.3496, 0),
  ('Abuja', 'NG', 4000000, 9.0765, 7.3986, 1),
  ('Lagos', 'NG', 16500000, 6.5244, 3.3792, 0),
  ('Wellington', 'NZ', 420000, -41.2865, 174.7762, 1),
  ('Auckland', 'NZ', 1700000, -36.8485, 174.7633, 0),
  ('Washington', 'US', 5400000, 38.9072, -77.0369, 1),
  ('New York', 'US', 19500000, 40.7128, -74.0060, 0),
  ('Los Angeles', 'US', 12500000, 34.0522, -118.2437, 0),
  ('Chicago', 'US', 8900000, 41.8781, -87.6298, 0),
  ('Pretoria', 'ZA', 2900000, -25.7479, 28.2293, 1),
  ('Johannesburg', 'ZA', 6200000, -26.2041, 28.0473, 0),
  ('Cape Town', 'ZA', 4800000, -33.9249, 18.4241, 0),
  ('Seoul', 'KR', 25900000, 37.5665, 126.9780, 1),
  ('Busan', 'KR', 3400000, 35.1796, 129.0756, 0);
