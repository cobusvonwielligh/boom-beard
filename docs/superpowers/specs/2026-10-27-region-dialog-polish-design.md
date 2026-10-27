# Region Dialog Polish Design

## Goal

Make the landing slogan and region dialog match the mascot's bandana and provide
stable, game-relevant server ping and occupancy readings.

## Visual changes

- Color the three landing slogan phrases with the bandana's maroon tone, add a
  restrained dark text shadow, and reduce the current 14.5px text size by 1pt.
- Replace the dialog's generated SVG flags with the user-provided South Africa
  and United States PNG assets. Render both in equal-size image boxes without
  distorting their artwork.
- Show total occupied seats (`humanPlayers + bots`) as the player count. For
  example, five bots and no humans display five players.
- Put a small refresh-icon button at the dialog's upper-right. It refreshes
  both region status counts and ping measurements, with an accessible label and
  a disabled/spinning state while refreshing.
- Put the gold, cast-shine Continue action on the left and make it the wide
  primary action. Put the smaller Cancel action on the right.

## Ping behavior

- Use the game's WebSocket PING/PONG protocol for dialog RTT, not HTTP fetch
  duration. The server already answers unauthenticated `ping` messages without
  creating a player seat.
- After a socket opens, take five samples with a short 100ms gap. Display the
  first valid reading immediately, animate subsequent improvements, and leave
  the final display at the minimum of all five.
- Apply this same fast five-sample burst when a game transport opens. Continue
  the existing rolling five-sample minimum for the in-game HUD so both places
  use the same units, packet, clock, and estimator.
- Fetch player/bot/capacity status separately from ping. A failed game socket
  probe makes that region unavailable for joining; a failed refresh reports
  the failure instead of leaving stale values presented as fresh.

## Validation

- Tests cover the user's PNG paths, total seat occupancy including bots,
  button ordering, refresh action, ping sample count/order/minimum, and in-game
  ping burst initialization.
- Verify the actual dialog at desktop and narrow viewport sizes and ensure its
  selection/Continue/Cancel flow remains keyboard accessible.
