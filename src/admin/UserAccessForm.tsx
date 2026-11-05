/** Account type, enabled state and permissions: shared by the add, edit and bulk
 *  screens. It holds no state, and the screen decides what gets saved. */
import { View } from 'react-native'
import {
  PERM_TOGGLES,
  USER_TYPE_OPTIONS,
  reseedPermissions,
  type ABSUserPermissions,
  type ABSUserType,
} from '@hearthshelf/core'
import { useAdminResource } from '@/admin/useAdminResource'
import { getPermissionChoices } from '@/api/admin/users'
import { AppText, Chip } from '@/ui/primitives'
import {
  Seg,
  SettingsGroup,
  SettingsLabel,
  SettingsRow,
  SettingsToggle,
} from '@/ui/settingsControls'
import { useColors } from '@/ui/ThemeProvider'
import { spacing } from '@/ui/theme'

export interface UserAccess {
  type: ABSUserType
  isActive: boolean
  permissions: ABSUserPermissions
}

const TYPE_OPTIONS = USER_TYPE_OPTIONS.map((t) => ({ value: t.value, label: t.label }))

function toggled(list: string[], id: string): string[] {
  return list.includes(id) ? list.filter((x) => x !== id) : [...list, id]
}

function Picker({
  label,
  options,
  selected,
  onToggle,
  empty,
  hint,
  failed,
}: {
  label: string
  options: { id: string; label: string }[]
  selected: string[]
  onToggle: (id: string) => void
  empty: string
  hint: string
  failed: boolean
}) {
  const colors = useColors()
  return (
    <View>
      <SettingsLabel>{label}</SettingsLabel>
      {options.length === 0 ? (
        <AppText variant="meta" color={colors.textMuted}>
          {failed ? "Couldn't load these. Go back and try again." : empty}
        </AppText>
      ) : (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }}>
          {options.map((o) => (
            <Chip
              key={o.id}
              label={o.label}
              active={selected.includes(o.id)}
              onPress={() => onToggle(o.id)}
            />
          ))}
        </View>
      )}
      {options.length > 0 && selected.length === 0 ? (
        <AppText variant="caption" color={colors.textMuted} style={{ marginTop: spacing.xs }}>
          {hint}
        </AppText>
      ) : null}
    </View>
  )
}

export function UserAccessForm({
  value,
  onChange,
  typeLocked,
  enabledLocked,
}: {
  value: UserAccess
  onChange: (next: UserAccess) => void
  /** Replaces the type picker with this explanation. */
  typeLocked?: string
  /** Replaces the enabled switch with this explanation. */
  enabledLocked?: string
}) {
  const choices = useAdminResource(getPermissionChoices)
  const { permissions: perms } = value
  const setPerms = (permissions: ABSUserPermissions) => onChange({ ...value, permissions })

  return (
    <>
      <View>
        <SettingsLabel>Account</SettingsLabel>
        <SettingsGroup>
          {typeLocked ? (
            <SettingsRow icon="badge" title="Account type" desc={typeLocked} />
          ) : (
            <SettingsRow icon="badge" title="Account type" stacked>
              <Seg
                fill
                label="Account type"
                value={value.type}
                options={TYPE_OPTIONS}
                onChange={(type) =>
                  onChange({ ...value, type, permissions: reseedPermissions(type, perms) })
                }
              />
            </SettingsRow>
          )}
          {enabledLocked ? (
            <SettingsRow icon="toggle-on" title="Enabled" desc={enabledLocked} last />
          ) : (
            <SettingsRow
              icon="toggle-on"
              title="Enabled"
              desc="Turn this off to stop them signing in."
              control={
                <SettingsToggle
                  on={value.isActive}
                  onChange={(isActive) => onChange({ ...value, isActive })}
                />
              }
              last
            />
          )}
        </SettingsGroup>
      </View>

      <View>
        <SettingsLabel>Permissions</SettingsLabel>
        <SettingsGroup>
          {PERM_TOGGLES.map((t, i) => (
            <SettingsRow
              key={t.key}
              title={t.label}
              control={
                <SettingsToggle
                  on={Boolean(perms[t.key])}
                  onChange={(on) => setPerms({ ...perms, [t.key]: on })}
                />
              }
              last={i === PERM_TOGGLES.length - 1}
            />
          ))}
        </SettingsGroup>
      </View>

      {perms.accessAllLibraries ? null : (
        <Picker
          label="Libraries they can open"
          options={choices.data?.libraries ?? []}
          selected={perms.librariesAccessible}
          onToggle={(id) =>
            setPerms({ ...perms, librariesAccessible: toggled(perms.librariesAccessible, id) })
          }
          empty="No libraries found."
          hint="Pick at least one, or they won't see any library."
          failed={Boolean(choices.error)}
        />
      )}

      {perms.accessAllTags ? null : (
        <Picker
          label="Tags they can see"
          options={choices.data?.tags ?? []}
          selected={perms.itemTagsSelected}
          onToggle={(id) =>
            setPerms({ ...perms, itemTagsSelected: toggled(perms.itemTagsSelected, id) })
          }
          empty="No tags in the library yet."
          hint="Pick at least one, or they won't see tagged books."
          failed={Boolean(choices.error)}
        />
      )}
    </>
  )
}
