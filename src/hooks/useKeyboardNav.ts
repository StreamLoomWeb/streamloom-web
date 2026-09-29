import { useEffect } from 'react'

interface Options {
  onEscape?: () => void
}

/**
 * TV & Desktop keyboard navigation hook.
 *
 * Supports:
 * - ArrowLeft / ArrowRight: Navigate horizontally between channel cards in a row
 * - ArrowUp / ArrowDown: Navigate vertically between rows / toolbar / search
 * - Enter: Activate/play channel (native button/role="button" handling)
 * - /: Instantly focus search bar
 * - Escape: Clear active filter / blur input
 */
// A card's own DOM node (`[data-card="channel"]`) is no longer itself
// focusable — the playable area and the favourite toggle are two separate
// buttons inside it (W8) — so arrow nav focuses whichever of the two is
// actually focusable, falling back to the card itself for anything else.
function focusCard(card: HTMLElement) {
  const target = card.querySelector<HTMLElement>('.channel-card__surface:not([disabled]), .channel-card__fav')
  ;(target ?? card).focus()
}

export function useKeyboardNav(options?: Options) {
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const activeEl = document.activeElement as HTMLElement | null
      const isInput =
        activeEl?.tagName === 'INPUT' ||
        activeEl?.tagName === 'TEXTAREA' ||
        activeEl?.tagName === 'SELECT'

      // Shortcut: "/" to focus search bar
      if (e.key === '/' && !isInput) {
        e.preventDefault()
        const searchInput = document.querySelector<HTMLInputElement>('.search-bar input, input[type="search"]')
        if (searchInput) {
          searchInput.focus()
          searchInput.select()
        }
        return
      }

      // Escape: blur or clear filters
      if (e.key === 'Escape') {
        // A modal <dialog> (e.g. the filter sheet) handles its own Escape —
        // it only closes itself. Don't also let it fall through to here and
        // wipe every active filter.
        if (document.querySelector('dialog[open]')) return
        if (isInput) {
          activeEl?.blur()
          return
        }
        options?.onEscape?.()
        return
      }

      // Vertical order on Home is navbar → hero → toolbar → cards. Up/Down walk it
      // so a D-pad user can reach the hero and the toolbar, not just the cards.
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key) && activeEl) {
        const inHero = activeEl.closest('.hero')
        const inToolbar = activeEl.closest('.home-toolbar')
        const heroBtns = () =>
          Array.from(document.querySelectorAll<HTMLElement>('.hero button:not([disabled])')).filter(
            (el) => el.offsetParent !== null
          )
        const searchOrFilter = () =>
          document.querySelector<HTMLElement>('.home-toolbar .search-bar input') ??
          document.querySelector<HTMLElement>('.home-toolbar button:not([disabled])')
        if (inHero) {
          e.preventDefault()
          if (e.key === 'ArrowDown') {
            const t = searchOrFilter()
            if (t) t.focus()
            else {
              const first = document.querySelector<HTMLElement>('[data-card="channel"]')
              if (first) focusCard(first)
            }
          } else if (e.key === 'ArrowUp') {
            document.querySelector<HTMLElement>('.navbar__link--active, .navbar__link')?.focus()
          } else {
            const btns = heroBtns()
            const i = btns.indexOf(activeEl)
            const next = btns[i + (e.key === 'ArrowRight' ? 1 : -1)]
            if (next) next.focus()
          }
          return
        }
        if (inToolbar && e.key === 'ArrowUp') {
          const hero = document.querySelector<HTMLElement>('.hero__btn--primary') ?? heroBtns()[0]
          if (hero) {
            e.preventDefault()
            hero.focus()
            hero.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
            return
          }
        }
      }

      // Arrow navigation
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
        // If typing inside an input, don't hijack left/right arrows unless arrow down to exit
        if (isInput) {
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            activeEl?.blur()
            const firstCard = document.querySelector<HTMLElement>('[data-card="channel"]')
            if (firstCard) focusCard(firstCard)
          }
          return
        }

        const cards = Array.from(document.querySelectorAll<HTMLElement>('[data-card="channel"]'))
        if (cards.length === 0) return

        // A card without a stream (shown, never hidden, on the picks row — ADR-0033 §3)
        // isn't itself in the tab order, so its favourite button is the only stop a
        // keyboard user lands on for that pin. Resolving from the closest ancestor
        // card, not an exact match, keeps arrow keys moving from there instead of
        // reading "not on a card" and snapping back to the first one.
        const currentCard = activeEl?.closest<HTMLElement>('[data-card="channel"]') ?? null
        const currentIndex = currentCard ? cards.indexOf(currentCard) : -1

        if (currentIndex === -1) {
          // If nothing is focused yet, focus the first card on any arrow press
          e.preventDefault()
          if (cards[0]) focusCard(cards[0])
          cards[0]?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' })
          return
        }

        const currentRect = currentCard!.getBoundingClientRect()

        if (e.key === 'ArrowRight') {
          e.preventDefault()
          const nextCard = cards[currentIndex + 1]
          if (nextCard) {
            focusCard(nextCard)
            nextCard.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' })
          }
        } else if (e.key === 'ArrowLeft') {
          e.preventDefault()
          const prevCard = cards[currentIndex - 1]
          if (prevCard) {
            focusCard(prevCard)
            prevCard.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' })
          }
        } else if (e.key === 'ArrowDown') {
          e.preventDefault()
          // Find the card in the next row below whose horizontal center is closest
          const belowCards = cards.filter((c) => {
            const rect = c.getBoundingClientRect()
            return rect.top > currentRect.bottom - 10
          })

          if (belowCards.length > 0) {
            // Find closest by horizontal center
            const currentCenter = currentRect.left + currentRect.width / 2
            let closest = belowCards[0]
            let minDist = Infinity
            for (const c of belowCards) {
              const r = c.getBoundingClientRect()
              const dist = Math.abs(r.left + r.width / 2 - currentCenter)
              if (dist < minDist) {
                minDist = dist
                closest = c
              }
            }
            focusCard(closest)
            closest.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' })
          }
        } else if (e.key === 'ArrowUp') {
          e.preventDefault()
          // Find card in row above
          const aboveCards = cards.filter((c) => {
            const rect = c.getBoundingClientRect()
            return rect.bottom < currentRect.top + 10
          })

          if (aboveCards.length > 0) {
            const currentCenter = currentRect.left + currentRect.width / 2
            let closest = aboveCards[0]
            let minDist = Infinity
            for (const c of aboveCards) {
              const r = c.getBoundingClientRect()
              const dist = Math.abs(r.left + r.width / 2 - currentCenter)
              if (dist < minDist) {
                minDist = dist
                closest = c
              }
            }
            focusCard(closest)
            closest.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' })
          } else {
            // Reached top row — jump to search bar or filter bar
            const searchInput = document.querySelector<HTMLInputElement>('.search-bar input')
            if (searchInput) {
              searchInput.focus()
              searchInput.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
            }
          }
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [options])
}
