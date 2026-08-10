#!/bin/sh
# Verify every translatable string in the UI exists in each catalogue.
#
# The failure this guards against is silent: a string added to the JS but not
# to po/ still renders, just untranslated, so nothing breaks in testing and
# the gap only shows up for users running a non-English LuCI.

set -eu

root="$(cd "$(dirname "$0")/.." && pwd)"
pot="$root/luci-app-thermal/po/templates/thermal.pot"

# Every view that renders user-visible text. A view added here but left out of
# this list would have its strings silently reported as stale.
srcs="$root/luci-app-thermal/htdocs/luci-static/resources/view/status/include/29_thermal.js
$root/luci-app-thermal/htdocs/luci-static/resources/view/thermal/graph.js"

for src in $srcs; do
	[ -f "$src" ] || { echo "missing source: $src" >&2; exit 1; }
done
[ -f "$pot" ] || { echo "missing template: $pot" >&2; exit 1; }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT HUP INT TERM

# Translatable strings as they appear in the code: _('...').
#
# grep -oE rather than sed, for two reasons: it catches every occurrence on a
# line instead of just the last, and the alternation handles a string that
# contains an escaped apostrophe (device\'s), which a [^']* class cannot.
# The captured text is then unescaped back to what _() actually receives.
for src in $srcs; do
	grep -oE "_\('([^'\\\\]|\\\\.)*'\)" "$src"
done | sed "s/^_('//; s/')$//; s/\\\\'/'/g" | sort -u > "$work/code"

# Every string the code passes through _() must be in the template, and every
# template entry must still exist in the code.
msgids() { sed -n 's/^msgid "\(.*\)"$/\1/p' "$1" | grep -v '^$' | sort -u; }

msgids "$pot" > "$work/pot"

status=0

# Strings contain spaces, so report them line-by-line rather than letting
# word splitting shred them into individual words.
report() {
	echo "$1" >&2
	sed 's/^/  /' "$2" >&2
	status=1
}

comm -23 "$work/code" "$work/pot" > "$work/missing"
[ -s "$work/missing" ] && report "strings used in the UI but absent from thermal.pot:" "$work/missing"

comm -13 "$work/code" "$work/pot" > "$work/stale"
[ -s "$work/stale" ] && report "entries in thermal.pot no longer used by the UI:" "$work/stale"

for po in "$root"/luci-app-thermal/po/*/*.po; do
	[ -e "$po" ] || continue
	lang="$(basename "$(dirname "$po")")"
	msgids "$po" > "$work/po"

	comm -23 "$work/code" "$work/po" > "$work/untranslated"
	[ -s "$work/untranslated" ] && report "$lang: missing translations:" "$work/untranslated"

	# An empty msgstr is worse than an absent entry: it renders as a blank
	# label rather than falling back to English.
	awk '/^msgid "/{id=$0} /^msgstr ""$/{if (id !~ /^msgid ""$/) print id}' "$po" > "$work/blank"
	[ -s "$work/blank" ] && report "$lang: entries with an empty msgstr:" "$work/blank"
done

[ "$status" -eq 0 ] && echo "i18n OK: $(wc -l < "$work/code" | tr -d ' ') strings, catalogues complete"
exit "$status"
