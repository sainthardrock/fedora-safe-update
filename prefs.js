import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import { ExtensionPreferences, gettext as _ } from 'resource:///org/gnome/shell/extensions/prefs.js';

export default class FedoraUpdateWatchPreferences extends ExtensionPreferences {
  fillPreferencesWindow(window) {
    const settings = this.getSettings();
    const page = new Adw.PreferencesPage();
    window.add(page);

    this._buildThresholdGroup(page, settings);
    this._buildWatchListGroup(page, settings);
  }

  _buildThresholdGroup(page, settings) {
    const group = new Adw.PreferencesGroup({ title: _('Risk Threshold') });
    page.add(group);

    const row = new Adw.SpinRow({
      title: _('Minimum days in stable'),
      subtitle: _('A watched package pushed to stable more recently than this is flagged as risky'),
      adjustment: new Gtk.Adjustment({ lower: 0, upper: 90, step_increment: 1 }),
    });
    group.add(row);

    settings.bind('min-stable-age-days', row, 'value', Gio.SettingsBindFlags.DEFAULT);
  }

  _buildWatchListGroup(page, settings) {
    const group = new Adw.PreferencesGroup({
      title: _('Watched Packages'),
      description: _(
        'Package names checked against Bodhi before being considered safe to install. ' +
          'Packages Bodhi has no record of (e.g. RPM Fusion builds) are flagged as untracked.'
      ),
    });
    page.add(group);

    const listBox = new Gtk.ListBox({ selection_mode: Gtk.SelectionMode.NONE });
    listBox.add_css_class('boxed-list');
    group.add(listBox);

    const renderList = () => {
      let child = listBox.get_first_child();
      while (child) {
        const next = child.get_next_sibling();
        listBox.remove(child);
        child = next;
      }
      for (const pkg of settings.get_strv('watch-list')) {
        const row = new Adw.ActionRow({ title: pkg });
        const removeButton = new Gtk.Button({
          icon_name: 'list-remove-symbolic',
          valign: Gtk.Align.CENTER,
          css_classes: ['flat'],
        });
        removeButton.connect('clicked', () => {
          const current = settings.get_strv('watch-list').filter((p) => p !== pkg);
          settings.set_strv('watch-list', current);
          renderList();
        });
        row.add_suffix(removeButton);
        listBox.append(row);
      }
    };
    renderList();

    const addRow = new Adw.EntryRow({ title: _('Add package name') });
    const addButton = new Gtk.Button({
      icon_name: 'list-add-symbolic',
      valign: Gtk.Align.CENTER,
      css_classes: ['flat'],
    });
    const addPackage = () => {
      // Lower-cased: RPM package names are conventionally lowercase, and
      // pkcon/dnf report them lowercase, so normalizing here means a
      // mistyped-case entry still matches instead of silently never firing.
      const name = addRow.get_text().trim().toLowerCase();
      if (!name) return;
      const current = settings.get_strv('watch-list');
      if (current.includes(name)) {
        // Visible feedback instead of silently doing nothing.
        addRow.add_css_class('error');
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1200, () => {
          addRow.remove_css_class('error');
          return GLib.SOURCE_REMOVE;
        });
        return;
      }
      settings.set_strv('watch-list', [...current, name]);
      renderList();
      addRow.set_text('');
    };
    addButton.connect('clicked', addPackage);
    addRow.connect('entry-activated', addPackage); // Enter key in the row
    addRow.add_suffix(addButton);
    group.add(addRow);
  }
}
