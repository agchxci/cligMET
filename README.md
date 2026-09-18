# cligMET — weather history navigation

This applies the prepared cligMET interface to the uploaded static-site repository, keeping its cyan palette, name, field artwork and public feed. All four weather plots and coefficient history have independent time navigation.

## Plot controls

| Control | Behaviour |
| --- | --- |
| 24 hours / 3 days | Hourly observed history; latest view also includes the next 24-hour forecast. |
| Week | Seven days of hourly history, plus the next 24-hour forecast in the latest view. |
| Month | One calendar month of history, shown as three-hour means. |
| Year | One calendar year, shown as daily means of available hourly values. |
| Previous / Next | Move that plot through adjacent historical periods. Month ends and leap years use calendar dates. |
| Latest | Return that plot to the latest period. |
| Forecast only | Next 24-hour forecast without historical navigation. |
| Coefficient history | All changes, Week, Month or Year, with step lines carrying forward the last known setting. |

Each chart has its own selection. Period choices are saved on the visitor's device. Historical windows remain anchored during automatic refresh. Changing period returns that plot to its latest window. Exact dates appear above every plot.

Month/year weather views also include the next 24-hour forecast when viewing the latest period. Older periods show observations. Forecasts are not extrapolated: only the current and archived runs supplied by the publisher are drawn where their timestamps fit.

Dates use the device time zone, named below the charts. Three-hour/daily averaging uses UTC buckets. Readouts show how many hourly values contribute to a larger average. No data is invented to fill empty periods.

## Deployment

1. Deploy the accompanying **receiver** update first. Configure persistent storage if history must survive restarts/redeploys; see its README.
2. Replace the static site's files with this repository's contents, retaining the existing Render publish directory and domain. No package installation or build step is required.
3. Retain the existing snapshot URL in `config.js`. The page derives `history.json` and `calibration-history.json` from it. Optional `CLIGMET_HISTORY_URL` and `CLIGMET_CALIBRATION_HISTORY_URL` overrides support different routes; setting either to `false` disables that archive request.
4. Check desktop/mobile layout, the feed and all range controls in a deployed preview before updating the live domain.

Without the receiver update, the current dashboard still works. Longer views explicitly show that only the current snapshot's history is available. At first the archive contains only the recent hours supplied by the publisher; older records need importing from saved snapshots or exporting from the home database.

## Other improvements included

- Clear temperature, humidity, irradiance, pressure, wind and rainfall readings.
- Refresh, connection recovery and explicit freshness.
- Responsive charts with hover/tap/keyboard inspection and visible-series controls.
- Missing values remain missing rather than displaying zero.
- Forecast errors to three decimal places; expandable coefficient history.
- Keyboard focus styles, skip link, reduced-motion support and page metadata.

API keys, station administration and forecast/calibration controls stay on the home dashboard. The website makes read-only GET requests.

## Suggested next improvements

1. **Recover the older station archive.** Import existing hourly records so month/year views are useful immediately, then maintain a durable archive with backups.
2. **Show temperature extremes.** Add daily minimum, maximum and mean. True daily extremes should come from the underlying observations; extrema of hourly averages must be labelled as such.
3. **Show forecast error by lead time.** Compare 1-, 6-, 12- and 24-hour predictions against observations instead of relying on one overall error.
4. **Export the selected period to CSV.** Include timestamps, units, averaging intervals and completeness counts.

See `VALIDATION.md` for completed and pending checks.
